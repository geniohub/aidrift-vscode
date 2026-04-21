// ClaudeCodeJSONLWatcher: tails ~/.claude/projects/**/*.jsonl and emits
// parsed entries as they're appended. Per-file byte offset tracking so we
// re-read only new bytes on each change.

import chokidar, { type FSWatcher } from "chokidar";
import { createReadStream, promises as fsp, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLine, type ParsedEntry } from "./jsonl-parser.js";

export type ClaudeEntryHandler = (entry: ParsedEntry, filePath: string) => Promise<void>;

export interface WatcherPersistence {
  load(): Record<string, number>;
  save(offsets: Record<string, number>): void;
}

const POLL_INTERVAL_MS = 4_000;
const OFFSET_SAVE_DEBOUNCE_MS = 1_500;

export class ClaudeCodeWatcher {
  private watcher: FSWatcher | undefined;
  private offsets = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly rootDir: string;

  constructor(
    private readonly onEntry: ClaudeEntryHandler,
    private readonly persistence?: WatcherPersistence,
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
  }

  private async ingestExistingFiles(): Promise<void> {
    const files = await this.listJsonlFiles(this.rootDir);
    files.sort();
    for (const filePath of files) {
      await this.ingest(filePath, true);
    }
  }

  private async listJsonlFiles(dir: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.listJsonlFiles(full)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
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
    this.offsets.clear();
  }

  /**
   * Drop all byte offsets (in-memory + persisted) and re-walk every JSONL
   * from byte 0. Server-side dedup on (sessionId, userPromptUuid) keeps the
   * replay idempotent. Used by the `aidrift.rescanClaudeHistory` command to
   * recover sessions that a prior (buggy) extension version dropped silently.
   */
  async rescanFromScratch(): Promise<void> {
    this.offsets.clear();
    this.persistence?.save({});
    await this.ingestExistingFiles();
  }

  private async sweep(): Promise<void> {
    // Re-ingest known files for missed change notifications, AND rediscover
    // new files chokidar didn't fire "add" for. macOS FSEvents occasionally
    // drops add-events for newly-created JSONLs, which would otherwise leave
    // a freshly-started Claude Code chat permanently unindexed.
    const known = new Set(this.offsets.keys());
    const found = await this.listJsonlFiles(this.rootDir);
    for (const p of found) {
      if (!known.has(p)) {
        await this.ingest(p, true);
      }
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
    const lastNewline = data.lastIndexOf(0x0a); // '\n'
    if (lastNewline === -1) return start; // no complete line in this slice

    const processable = data.subarray(0, lastNewline).toString("utf8");
    const lines = processable.split("\n");
    for (const line of lines) {
      if (!line) continue;
      const entry = parseLine(line);
      if (entry.kind === "skip") continue;
      try {
        await this.onEntry(entry, filePath);
      } catch (err) {
        console.error("[aidrift] onEntry handler threw:", err);
      }
    }
    return start + lastNewline + 1;
  }
}
