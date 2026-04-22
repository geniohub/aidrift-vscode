// ClaudeCodeJSONLWatcher: tails ~/.claude/projects/**/*.jsonl and emits
// parsed entries as they're appended. Per-file byte offset tracking so we
// re-read only new bytes on each change.

import chokidar, { type FSWatcher } from "chokidar";
import { createReadStream, promises as fsp, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLine, type ParsedEntry } from "./jsonl-parser.js";

export type ClaudeEntryHandler = (entry: ParsedEntry, filePath: string) => Promise<void>;

export interface IngestOpts {
  concurrency?: number;
  onProgress?: (done: number, total: number, currentFile?: string) => void;
  // If true, pull in every .jsonl regardless of mtime. Used by the explicit
  // "Rescan Claude Code History" command so users can still force-ingest
  // older transcripts on demand. False (default) skips files whose mtime
  // is older than DORMANT_MTIME_MS.
  includeDormant?: boolean;
}

export interface WatcherLog {
  info(msg: string, data?: Record<string, unknown>): void;
}

export interface WatcherPersistence {
  load(): Record<string, number>;
  save(offsets: Record<string, number>): void;
}

const POLL_INTERVAL_MS = 4_000;
const OFFSET_SAVE_DEBOUNCE_MS = 1_500;
// Files whose mtime is older than this are treated as dormant transcripts
// from past sessions and skipped entirely — not tailed, not re-ingested on
// startup, not polled. Server-side dedup would otherwise absorb the flood
// silently, but the HTTP + Prisma pipeline still costs money per replayed
// line, and a user can accumulate hundreds of dormant JSONL files in a
// single project over a few months. The "Rescan Claude Code History"
// command clears offsets and walks everything from byte 0 regardless of
// mtime, so older files can still be pulled in explicitly.
const DORMANT_MTIME_MS = 24 * 60 * 60 * 1000; // 24h

export class ClaudeCodeWatcher {
  private watcher: FSWatcher | undefined;
  private offsets = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  // Per-file ingest serialization: chokidar "add/change" and periodic sweep
  // can race each other; without a lock they can re-read the same byte range
  // before offsets advance, replaying identical JSONL lines.
  private readonly ingestInFlight = new Map<string, Promise<void>>();
  private readonly ingestQueued = new Set<string>();
  // setInterval doesn't await async callbacks; when a sweep takes longer than
  // POLL_INTERVAL_MS, overlapping sweeps can start. Collapse overlap into one
  // extra pass instead of running concurrently.
  private sweepInFlight = false;
  private sweepQueued = false;
  private statsTimer: NodeJS.Timeout | undefined;
  private readonly stats = {
    ingestCalls: 0,
    ingestQueued: 0,
    emittedEntries: 0,
    bytesRead: 0,
    sweeps: 0,
    sweepQueued: 0,
  };
  private readonly rootDir: string;

  constructor(
    private readonly onEntry: ClaudeEntryHandler,
    private readonly persistence?: WatcherPersistence,
    private readonly log?: WatcherLog,
  ) {
    this.rootDir = join(homedir(), ".claude", "projects");
    // Hydrate from globalState so a VSCode reload doesn't re-walk every JSONL
    // from byte 0. Server-side dedup catches duplicates, but this saves the
    // redundant parse + HTTP round-trips.
    if (persistence) {
      for (const [path, offset] of Object.entries(persistence.load())) {
        this.offsets.set(path, offset);
      }
    }
  }

  private schedulePersist(): void {
    if (!this.persistence) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.persistence?.save(Object.fromEntries(this.offsets));
    }, OFFSET_SAVE_DEBOUNCE_MS);
  }

  async start(): Promise<void> {
    try {
      await fsp.access(this.rootDir);
    } catch {
      // No Claude Code history yet — watch anyway; chokidar tolerates it.
    }

    // Chokidar 4 dropped glob support, so we watch the root dir directly and
    // filter .jsonl in the handler. awaitWriteFinish is deliberately NOT set:
    // Claude Code appends continuously during a long turn, and awaitWriteFinish
    // would block change events for an active conversation. Our offset tracking
    // handles partial trailing lines safely. ignoreInitial + a manual readdir
    // sweep on "ready" matches the CodexWatcher pattern (chokidar can miss
    // initial add events on some hosts).
    this.watcher = chokidar.watch(this.rootDir, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
    });

    this.watcher.on("ready", () => void this.ingestExistingFiles());
    this.watcher.on("add", (p) => {
      if (p.endsWith(".jsonl")) void this.ingest(p, true);
    });
    this.watcher.on("change", (p) => {
      if (p.endsWith(".jsonl")) void this.ingest(p);
    });
    this.watcher.on("unlink", (p) => {
      if (p.endsWith(".jsonl")) this.offsets.delete(p);
    });

    // FSEvents on macOS occasionally drops change notifications for files
    // under rapid append. A short polling sweep over files we've already seen
    // catches any growth we missed.
    this.pollTimer = setInterval(() => void this.sweep(), POLL_INTERVAL_MS);
    this.statsTimer = setInterval(() => this.emitStats("tick"), 15_000);
  }

  private async ingestExistingFiles(opts?: IngestOpts): Promise<void> {
    const all = await this.listJsonlFiles(this.rootDir);
    const includeDormant = opts?.includeDormant ?? false;
    const now = Date.now();
    // Always keep files we already have an offset for — skipping them would
    // strand partial offsets and let Claude Code's next append go unread.
    const files: string[] = [];
    let skippedDormant = 0;
    for (const f of all) {
      const isDormant = now - f.mtimeMs > DORMANT_MTIME_MS;
      if (!includeDormant && isDormant && !this.offsets.has(f.path)) {
        skippedDormant++;
        continue;
      }
      files.push(f.path);
    }
    files.sort();
    this.log?.info("claude watcher scan", {
      totalFiles: all.length,
      watching: files.length,
      skippedDormant,
      includeDormant,
    });
    const concurrency = Math.max(1, opts?.concurrency ?? 1);
    const onProgress = opts?.onProgress;
    let done = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < files.length) {
        const idx = cursor++;
        const filePath = files[idx];
        if (!filePath) continue;
        try {
          await this.ingest(filePath, true);
        } catch (err) {
          console.error(`[aidrift] rescan failed for ${filePath}:`, err);
        }
        done++;
        onProgress?.(done, files.length, filePath);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  private async listJsonlFiles(
    dir: string,
  ): Promise<Array<{ path: string; mtimeMs: number }>> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.listJsonlFiles(full)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = statSync(full);
          out.push({ path: full, mtimeMs: stat.mtimeMs });
        } catch {
          // fs race: file was removed between readdir and stat — skip.
        }
      }
    }
    return out;
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      // Flush pending offsets before teardown so the next activation picks
      // up where we left off.
      this.persistence?.save(Object.fromEntries(this.offsets));
    }
    await this.watcher?.close();
    this.watcher = undefined;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = undefined;
    }
    this.emitStats("stop");
    this.ingestInFlight.clear();
    this.ingestQueued.clear();
    this.sweepInFlight = false;
    this.sweepQueued = false;
    this.offsets.clear();
  }

  /**
   * Drop all byte offsets (in-memory + persisted) and re-walk every JSONL
   * from byte 0. Server-side dedup on (sessionId, userPromptUuid) keeps the
   * replay idempotent. Used by the `aidrift.rescanClaudeHistory` command to
   * recover sessions that a prior (buggy) extension version dropped silently.
   */
  async rescanFromScratch(opts?: IngestOpts): Promise<void> {
    this.offsets.clear();
    this.persistence?.save({});
    await this.ingestExistingFiles(opts);
  }

  private async sweep(): Promise<void> {
    if (this.sweepInFlight) {
      this.stats.sweepQueued++;
      this.sweepQueued = true;
      return;
    }
    this.stats.sweeps++;
    this.sweepInFlight = true;
    try {
      do {
        this.sweepQueued = false;
        await this.sweepOnce();
      } while (this.sweepQueued);
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweepOnce(): Promise<void> {
    // Re-ingest known files for missed change notifications, AND rediscover
    // new files chokidar didn't fire "add" for. macOS FSEvents occasionally
    // drops add-events for newly-created JSONLs, which would otherwise leave
    // a freshly-started Claude Code chat permanently unindexed. Dormant
    // files are not newly-adopted here (they were already filtered on
    // startup); if one suddenly gets appended, chokidar's "change" event
    // fires and brings it in through the normal path.
    const known = new Set(this.offsets.keys());
    const found = await this.listJsonlFiles(this.rootDir);
    const now = Date.now();
    for (const f of found) {
      if (known.has(f.path)) continue;
      if (now - f.mtimeMs > DORMANT_MTIME_MS) continue;
      await this.ingest(f.path, true);
    }
    for (const p of known) {
      await this.ingest(p);
    }
  }

  /**
   * Read new bytes since the last tracked offset and emit any complete lines.
   * `initial=true` means a newly-discovered file — start from 0 in case this
   * is the first run against a pre-existing transcript. Partial trailing
   * lines are NOT consumed: the offset only advances past the last `\n`, so
   * the rest of the line is picked up on the next call.
   */
  private async ingest(filePath: string, initial = false): Promise<void> {
    this.stats.ingestCalls++;
    const running = this.ingestInFlight.get(filePath);
    if (running) {
      this.stats.ingestQueued++;
      this.ingestQueued.add(filePath);
      await running;
      return;
    }

    const run = (async () => {
      let first = initial;
      while (true) {
        await this.ingestOnce(filePath, first);
        first = false;
        if (!this.ingestQueued.delete(filePath)) break;
      }
    })();
    this.ingestInFlight.set(filePath, run);
    try {
      await run;
    } finally {
      this.ingestInFlight.delete(filePath);
    }
  }

  private async ingestOnce(filePath: string, initial = false): Promise<void> {
    const prior = this.offsets.get(filePath);
    const start = initial && prior === undefined ? 0 : prior ?? 0;
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      this.offsets.delete(filePath);
      this.schedulePersist();
      return;
    }
    if (size <= start) {
      this.offsets.set(filePath, size);
      this.schedulePersist();
      return;
    }
    const next = await this.readRange(filePath, start, size);
    this.offsets.set(filePath, next);
    this.schedulePersist();
  }

  private async readRange(filePath: string, start: number, end: number): Promise<number> {
    // Read as Buffer (no `encoding` option) so we can track byte positions
    // precisely — character indexing lies for multi-byte UTF-8 content.
    const stream = createReadStream(filePath, { start, end: end - 1 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const data = Buffer.concat(chunks);
    this.stats.bytesRead += data.length;
    const lastNewline = data.lastIndexOf(0x0a); // '\n'
    if (lastNewline === -1) return start; // no complete line in this slice

    const processable = data.subarray(0, lastNewline).toString("utf8");
    const lines = processable.split("\n");
    for (const line of lines) {
      if (!line) continue;
      const entry = parseLine(line);
      if (entry.kind === "skip") continue;
      this.stats.emittedEntries++;
      try {
        await this.onEntry(entry, filePath);
      } catch (err) {
        console.error("[aidrift] onEntry handler threw:", err);
      }
    }
    return start + lastNewline + 1;
  }

  private emitStats(reason: string): void {
    if (!this.log) return;
    if (
      this.stats.ingestCalls === 0 &&
      this.stats.emittedEntries === 0 &&
      this.stats.sweeps === 0
    ) {
      return;
    }
    this.log.info("claude watcher stats", {
      reason,
      ...this.stats,
      trackedFiles: this.offsets.size,
    });
    this.stats.ingestCalls = 0;
    this.stats.ingestQueued = 0;
    this.stats.emittedEntries = 0;
    this.stats.bytesRead = 0;
    this.stats.sweeps = 0;
    this.stats.sweepQueued = 0;
  }
}
