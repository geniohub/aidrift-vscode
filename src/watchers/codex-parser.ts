// Parses OpenAI Codex agent rollout JSONL lines
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
//
// Format: every line is {timestamp, type, payload}.
//   type="session_meta" → first line, payload.id is the session UUID.
//   type="response_item", payload.type="message" → conversation turn.
//     payload.role ∈ {developer, user, assistant}
//     payload.content = [{type: input_text | output_text, text}, …]
// Developer-role messages are system context injected by Codex; skip.
// Reasoning / function_call / function_call_output payloads skipped.

import type { ParsedEntry } from "./jsonl-parser.js";

interface ContentBlock {
  type: string;
  text?: string;
}

interface MessagePayload {
  type: "message";
  role: "developer" | "user" | "assistant";
  content: ContentBlock[];
}

interface SessionMetaPayload {
  id: string;
}

interface RawLine {
  type: string;
  timestamp?: string;
  payload?: unknown;
}

interface CodexParserState {
  /** sessionHint resolved from the file's first session_meta line, or from the filename. */
  sessionHint: string | null;
}

function extractText(content: ContentBlock[] | undefined, keepTypes: string[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => keepTypes.includes(b.type) && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n");
}

/**
 * Best-effort session hint from a rollout filename:
 *   rollout-2026-04-15T13-38-39-<uuid>.jsonl
 * → returns <uuid>. Used as a fallback before we see the first
 * session_meta entry. Matches the format observed in April 2026.
 */
export function sessionHintFromFilename(path: string): string | null {
  const m = /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f-]{36,})\.jsonl$/i.exec(path);
  return m ? (m[1] ?? null) : null;
}

export function createCodexParser(initialHint: string | null): (line: string) => ParsedEntry {
  const state: CodexParserState = { sessionHint: initialHint };
  let syntheticCounter = 0;

  return (line: string): ParsedEntry => {
    if (!line.trim()) return { kind: "skip" };
    let raw: RawLine;
    try {
      raw = JSON.parse(line) as RawLine;
    } catch {
      return { kind: "skip" };
    }
    const ts = raw.timestamp ?? new Date().toISOString();

    if (raw.type === "session_meta" && raw.payload) {
      const meta = raw.payload as SessionMetaPayload;
      if (meta.id) state.sessionHint = meta.id;
      return { kind: "skip" };
    }

    if (raw.type !== "response_item" || !raw.payload) return { kind: "skip" };

    const payload = raw.payload as { type?: string } & Partial<MessagePayload>;
    if (payload.type !== "message") return { kind: "skip" };
    if (payload.role === "developer") return { kind: "skip" };

    const sessionHint = state.sessionHint;
    if (!sessionHint) return { kind: "skip" };

    if (payload.role === "user") {
      const text = extractText(payload.content, ["input_text"]);
      if (!text) return { kind: "skip" };
      syntheticCounter++;
      return {
        kind: "user-prompt",
        uuid: `codex-${sessionHint}-u${syntheticCounter}`,
        sessionHint,
        text,
        timestamp: ts,
      };
    }

    if (payload.role === "assistant") {
      const text = extractText(payload.content, ["output_text"]);
      if (!text) return { kind: "skip" };
      syntheticCounter++;
      return {
        kind: "assistant-reply",
        uuid: `codex-${sessionHint}-a${syntheticCounter}`,
        sessionHint,
        text,
        timestamp: ts,
      };
    }

    return { kind: "skip" };
  };
}
