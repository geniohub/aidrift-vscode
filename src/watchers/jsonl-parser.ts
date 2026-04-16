// Parses one line of a Claude Code JSONL transcript into a shape the
// session manager understands. Claude Code transcripts mix many entry
// types; we only care about real user prompts and assistant text.

export interface ParsedUserPrompt {
  kind: "user-prompt";
  uuid: string;
  sessionHint: string;
  text: string;
  timestamp: string;
  workspacePath?: string;
}

export interface ParsedAssistantReply {
  kind: "assistant-reply";
  uuid: string;
  sessionHint: string;
  text: string;
  timestamp: string;
  model?: string;
  parentUuid?: string;
  workspacePath?: string;
  /**
   * Tool-call fingerprints extracted from this assistant message, one per
   * tool_use block. Format: `"<tool>:<key>"` — e.g. `"read:/abs/path.ts"`,
   * `"bash:npm test"`. Used by the scoring engine to detect churn (same
   * action repeated across turns).
   */
  toolCalls: string[];
}

export type ParsedEntry = ParsedUserPrompt | ParsedAssistantReply | { kind: "skip" };

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
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

/**
 * Normalize a tool_use block into a short `tool:key` fingerprint. Returns
 * null when the block isn't a tool_use, the tool is unknown, or the key
 * argument is missing. The goal is stability across retries, so we lowercase
 * and collapse whitespace on free-text keys (bash command, grep pattern).
 */
export function fingerprintToolUse(block: ContentBlock): string | null {
  if (block.type !== "tool_use") return null;
  const name = block.name?.toLowerCase();
  const input = block.input ?? {};
  if (!name) return null;

  const path = typeof input.file_path === "string" ? input.file_path : null;
  const pattern = typeof input.pattern === "string" ? input.pattern : null;
  const command = typeof input.command === "string" ? input.command : null;

  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);

  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "multiedit":
    case "notebookedit":
      return path ? `${name}:${path}` : null;
    case "bash":
      return command ? `bash:${norm(command)}` : null;
    case "grep":
      return pattern ? `grep:${norm(pattern)}` : null;
    case "glob":
      return pattern ? `glob:${norm(pattern)}` : null;
    default:
      return null;
  }
}

export function extractToolCalls(content: string | ContentBlock[] | undefined): string[] {
  if (!content || typeof content === "string" || !Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const fp = fingerprintToolUse(block);
    if (fp) out.push(fp);
  }
  return out;
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
    // Keep text blocks for scoring text; tool_use blocks get fingerprinted
    // separately so we can detect action-level churn (edit-revert, re-read,
    // bash-retry) that a pure-text similarity check can't see.
    const text = extractTextBlocks(raw.message?.content, ["text"]);
    const toolCalls = extractToolCalls(raw.message?.content);
    if (!text && toolCalls.length === 0) return { kind: "skip" };
    return {
      kind: "assistant-reply",
      uuid: raw.uuid,
      sessionHint: raw.sessionId,
      text,
      timestamp: raw.timestamp,
      model: raw.message?.model,
      parentUuid: raw.parentUuid,
      toolCalls,
    };
  }

  return { kind: "skip" };
}
