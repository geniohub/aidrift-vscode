// CodexWatcher: tails ~/.codex/sessions/**/rollout-*.jsonl.
// Same byte-offset approach as ClaudeCodeWatcher but each file has its
// own stateful parser (Codex needs to see session_meta first).

import chokidar, { type FSWatcher } from "chokidar";
import { createReadStream, promises as fsp, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ParsedEntry } from "./jsonl-parser.js";
import { createCodexParser, sessionHintFromFilename } from "./codex-parser.js";

export type CodexEntryHandler = (entry: ParsedEntry, filePath: string) => Promise<void>;
const POLL_INTERVAL_MS = 4_000;

export class CodexWatcher {
  private watcher: FSWatcher | undefined;
  private readonly offsets = new Map<string, number>();
  private readonly parsers = new Map<string, (line: string) => ParsedEntry>();
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly rootDir: string;

  constructor(private readonly onEntry: CodexEntryHandler) {
    this.rootDir = join(homedir(), ".codex", "sessions");
  }

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.rootDir, {
      persistent: true,
      // We perform our own deterministic initial scan on "ready" because
      // chokidar initial add events can be missed on some hosts.
      ignoreInitial: true,
      followSymlinks: false,
    });
    this.watcher.on("ready", () => void this.ingestExistingFiles());
    this.watcher.on("add", (p) => {
      if (isRolloutFilePath(p)) void this.ingest(p, true);
    });
    this.watcher.on("change", (p) => {
      if (isRolloutFilePath(p)) void this.ingest(p);
    });
    this.watcher.on("unlink", (p) => {
      if (isRolloutFilePath(p)) this.dropFileState(p);
    });
    // FSEvents can occasionally miss rapid append notifications.
    this.pollTimer = setInterval(() => void this.sweep(), POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.watcher?.close();
    this.watcher = undefined;
    this.offsets.clear();
    this.parsers.clear();
  }

  private getParser(filePath: string): (line: string) => ParsedEntry {
    let parser = this.parsers.get(filePath);
    if (!parser) {
      parser = createCodexParser(sessionHintFromFilename(filePath));
      this.parsers.set(filePath, parser);
    }
    return parser;
  }

  private async ingest(filePath: string, initial = false): Promise<void> {
    const prior = this.offsets.get(filePath);
    const start = initial && prior === undefined ? 0 : prior ?? 0;
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      this.dropFileState(filePath);
      return;
    }
    if (size <= start) {
      this.offsets.set(filePath, size);
      return;
    }
    const next = await this.readRange(filePath, start, size);
    this.offsets.set(filePath, next);
  }

  private async readRange(filePath: string, start: number, end: number): Promise<number> {
    const parser = this.getParser(filePath);
    // Read as bytes and only consume complete newline-terminated lines.
    const stream = createReadStream(filePath, { start, end: end - 1 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const data = Buffer.concat(chunks);
    const lastNewline = data.lastIndexOf(0x0a); // '\n'
    if (lastNewline === -1) return start; // wait for a complete line

    const processable = data.subarray(0, lastNewline).toString("utf8");
    const lines = processable.split("\n");
    for (const line of lines) {
      if (!line) continue;
      const entry = parser(line);
      if (entry.kind !== "skip") {
        try {
          await this.onEntry(entry, filePath);
        } catch (err) {
          console.error("[aidrift] codex onEntry threw:", err);
        }
      }
    }
    return start + lastNewline + 1;
  }

  private async sweep(): Promise<void> {
    for (const p of this.offsets.keys()) {
      await this.ingest(p);
    }
  }

  private async ingestExistingFiles(): Promise<void> {
    const files = await this.listRolloutFiles(this.rootDir);
    files.sort();
    for (const filePath of files) {
      await this.ingest(filePath, true);
    }
  }

  private async listRolloutFiles(dir: string): Promise<string[]> {
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
        out.push(...(await this.listRolloutFiles(full)));
        continue;
      }
      if (entry.isFile() && isRolloutFilePath(full)) {
        out.push(full);
      }
    }
    return out;
  }

  private dropFileState(filePath: string): void {
    this.offsets.delete(filePath);
    this.parsers.delete(filePath);
  }
}

function isRolloutFilePath(path: string): boolean {
  const name = basename(path);
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}
