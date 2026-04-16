// ClaudeCodeJSONLWatcher: tails ~/.claude/projects/**/*.jsonl and emits
// parsed entries as they're appended. Per-file byte offset tracking so we
// re-read only new bytes on each change.

import chokidar, { type FSWatcher } from "chokidar";
import { createReadStream, promises as fsp, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLine, type ParsedEntry } from "./jsonl-parser.js";

export type ClaudeEntryHandler = (entry: ParsedEntry, filePath: string) => Promise<void>;

export class ClaudeCodeWatcher {
  private watcher: FSWatcher | undefined;
  private offsets = new Map<string, number>();
  private readonly rootDir: string;

  constructor(private readonly onEntry: ClaudeEntryHandler) {
    this.rootDir = join(homedir(), ".claude", "projects");
  }

  async start(): Promise<void> {
    try {
      await fsp.access(this.rootDir);
    } catch {
      // No Claude Code history yet — watch anyway; chokidar tolerates it.
    }

    this.watcher = chokidar.watch(`${this.rootDir}/**/*.jsonl`, {
      persistent: true,
      ignoreInitial: false,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    this.watcher.on("add", (p) => void this.ingest(p, true));
    this.watcher.on("change", (p) => void this.ingest(p, false));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
    this.offsets.clear();
  }

  /**
   * Read from the tracked offset to EOF. On `initial=true` (new file
   * discovered on startup), we still read from 0 so we pick up existing
   * content in case this is the first time the extension runs against a
   * pre-existing transcript.
   */
  private async ingest(filePath: string, initial: boolean): Promise<void> {
    const start = initial ? 0 : this.offsets.get(filePath) ?? 0;
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }
    if (size <= start) {
      this.offsets.set(filePath, size);
      return;
    }
    await this.readRange(filePath, start, size);
    this.offsets.set(filePath, size);
  }

  private async readRange(filePath: string, start: number, end: number): Promise<void> {
    const stream = createReadStream(filePath, { start, end: end - 1, encoding: "utf8" });
    let buffered = "";
    for await (const chunk of stream) {
      buffered += chunk as string;
      let newlineIdx: number;
      while ((newlineIdx = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newlineIdx);
        buffered = buffered.slice(newlineIdx + 1);
        const entry = parseLine(line);
        if (entry.kind !== "skip") {
          try {
            await this.onEntry(entry, filePath);
          } catch (err) {
            console.error("[aidrift] onEntry handler threw:", err);
          }
        }
      }
    }
    if (buffered.trim().length > 0) {
      const entry = parseLine(buffered);
      if (entry.kind !== "skip") {
        try {
          await this.onEntry(entry, filePath);
        } catch (err) {
          console.error("[aidrift] onEntry handler threw:", err);
        }
      }
    }
  }
}
