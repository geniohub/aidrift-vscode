// CodexWatcher: tails ~/.codex/sessions/**/rollout-*.jsonl.
// Same byte-offset approach as ClaudeCodeWatcher but each file has its
// own stateful parser (Codex needs to see session_meta first).

import chokidar, { type FSWatcher } from "chokidar";
import { createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedEntry } from "./jsonl-parser.js";
import { createCodexParser, sessionHintFromFilename } from "./codex-parser.js";

export type CodexEntryHandler = (entry: ParsedEntry, filePath: string) => Promise<void>;

export class CodexWatcher {
  private watcher: FSWatcher | undefined;
  private readonly offsets = new Map<string, number>();
  private readonly parsers = new Map<string, (line: string) => ParsedEntry>();
  private readonly rootDir: string;

  constructor(private readonly onEntry: CodexEntryHandler) {
    this.rootDir = join(homedir(), ".codex", "sessions");
  }

  async start(): Promise<void> {
    this.watcher = chokidar.watch(`${this.rootDir}/**/rollout-*.jsonl`, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.watcher.on("add", (p) => void this.ingest(p));
    this.watcher.on("change", (p) => void this.ingest(p));
  }

  async stop(): Promise<void> {
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

  private async ingest(filePath: string): Promise<void> {
    const start = this.offsets.get(filePath) ?? 0;
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
    const parser = this.getParser(filePath);
    const stream = createReadStream(filePath, { start, end: size - 1, encoding: "utf8" });
    let buffered = "";
    for await (const chunk of stream) {
      buffered += chunk as string;
      let newlineIdx: number;
      while ((newlineIdx = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newlineIdx);
        buffered = buffered.slice(newlineIdx + 1);
        const entry = parser(line);
        if (entry.kind !== "skip") {
          try {
            await this.onEntry(entry, filePath);
          } catch (err) {
            console.error("[aidrift] codex onEntry threw:", err);
          }
        }
      }
    }
    if (buffered.trim().length > 0) {
      const entry = parser(buffered);
      if (entry.kind !== "skip") {
        try {
          await this.onEntry(entry, filePath);
        } catch (err) {
          console.error("[aidrift] codex onEntry threw:", err);
        }
      }
    }
    this.offsets.set(filePath, size);
  }
}
