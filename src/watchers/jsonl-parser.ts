// Parses one line of a Claude Code JSONL transcript into a shape the
// session manager understands. Claude Code transcripts mix many entry
// types; we only care about real user prompts and assistant text.

export interface ParsedUserPrompt {
  kind: "user-prompt";
  uuid: string;
  sessionHint: string;
  text: string;
  timestamp: string;
}

export interface ParsedAssistantReply {
  kind: "assistant-reply";
  uuid: string;
  sessionHint: string;
  text: string;
  timestamp: string;
  model?: string;
  parentUuid?: string;
}

export type ParsedEntry = ParsedUserPrompt | ParsedAssistantReply | { kind: "skip" };

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

interface Message {
  role?: string;
  content?: string | ContentBlock[];
  model?: string;
}

interface RawEntry {
  type: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: Message;
  userType?: string;
}

function extractTextBlocks(content: string | ContentBlock[] | undefined, keep: string[]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!keep.includes(block.type)) continue;
    if (block.type === "text" && block.text) parts.push(block.text);
    else if (block.type === "thinking" && block.thinking) parts.push(block.thinking);
  }
  return parts.join("\n\n");
}

export function parseLine(line: string): ParsedEntry {
  if (!line.trim()) return { kind: "skip" };
  let raw: RawEntry;
  try {
    raw = JSON.parse(line) as RawEntry;
  } catch {
    return { kind: "skip" };
  }

  if (!raw.sessionId || !raw.uuid || !raw.timestamp) return { kind: "skip" };

  if (raw.type === "user") {
    // "user" entries include real prompts AND tool_result injections.
    // Real prompts have text blocks; tool_results have type:"tool_result".
    const text = extractTextBlocks(raw.message?.content, ["text"]);
    if (!text) return { kind: "skip" };
    return {
      kind: "user-prompt",
      uuid: raw.uuid,
      sessionHint: raw.sessionId,
      text,
      timestamp: raw.timestamp,
    };
  }

  if (raw.type === "assistant") {
    // Keep only `text` blocks — drop thinking (internal) and tool_use (noisy).
    // In v2 we may want to include tool_use summaries for richer scoring.
    const text = extractTextBlocks(raw.message?.content, ["text"]);
    if (!text) return { kind: "skip" };
    return {
      kind: "assistant-reply",
      uuid: raw.uuid,
      sessionHint: raw.sessionId,
      text,
      timestamp: raw.timestamp,
      model: raw.message?.model,
      parentUuid: raw.parentUuid,
    };
  }

  return { kind: "skip" };
}
