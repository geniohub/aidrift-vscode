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

export interface ParsedFileEdit {
  filePath: string;
  editKind: "create" | "modify" | "delete";
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
  /**
   * Structured file edits extracted from Edit / Write / MultiEdit tool_use
   * blocks. Only write-like operations land here — `read:` tool calls stay
   * as fingerprints. Used by the collision detector (v1: file-only).
   */
  fileEdits: ParsedFileEdit[];
  /**
   * Bash tool_use blocks whose command matches lint/build/test. Paired with
   * incoming tool_result entries by toolUseId to derive execution events for
   * the Code Quality dashboard.
   */
  bashExecHints: BashExecHint[];
}

export type ExecStage = "lint" | "build" | "test";

export interface BashExecHint {
  toolUseId: string;
  command: string;
  stage: ExecStage;
}

export interface ParsedAiTitle {
  kind: "ai-title";
  sessionHint: string;
  title: string;
}

export interface ParsedToolResults {
  kind: "tool-results";
  sessionHint: string;
  results: Array<{ toolUseId: string; isError: boolean }>;
  timestamp: string;
}

export type ParsedEntry = ParsedUserPrompt | ParsedAssistantReply | ParsedAiTitle | ParsedToolResults | { kind: "skip" };

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string;
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

const CONTEXT_TAG_RE = /<(?:ide_[a-z_]+|system-reminder|environment_context|context|status|instructions)>[\s\S]*?<\/(?:ide_[a-z_]+|system-reminder|environment_context|context|status|instructions)>/gi;

export function stripIdeTags(text: string): string {
  return text.replace(CONTEXT_TAG_RE, "").trim();
}

function extractTextBlocks(content: string | ContentBlock[] | undefined, keep: string[]): string {
  if (!content) return "";
  if (typeof content === "string") return stripIdeTags(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!keep.includes(block.type)) continue;
    if (block.type === "text" && block.text) {
      const cleaned = stripIdeTags(block.text);
      if (cleaned) parts.push(cleaned);
    } else if (block.type === "thinking" && block.thinking) parts.push(block.thinking);
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

/**
 * Extract structured file edits from an assistant message. Only write-like
 * tools count: Edit / Write / MultiEdit / NotebookEdit. Read / Bash /
 * Grep / Glob are observations, not edits. We don't parse line ranges
 * (v1 is file-only); the collision detector only needs filePath + kind.
 */
export function extractFileEdits(content: string | ContentBlock[] | undefined): ParsedFileEdit[] {
  if (!content || typeof content === "string" || !Array.isArray(content)) return [];
  const out: ParsedFileEdit[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const name = block.name?.toLowerCase();
    const input = block.input ?? {};
    const filePath = typeof input.file_path === "string" ? input.file_path : null;
    if (!filePath) continue;
    switch (name) {
      case "write":
        out.push({ filePath, editKind: "create" });
        break;
      case "edit":
      case "multiedit":
      case "notebookedit":
        out.push({ filePath, editKind: "modify" });
        break;
      default:
        break;
    }
  }
  return out;
}

const LINT_RE = /\b(lint|eslint|prettier|stylelint|biome)\b/i;
const TEST_RE = /\b(test|vitest|jest|mocha|pytest|spec|cypress|playwright)\b/i;
const BUILD_RE = /\b(build|compile|bundle|tsc|typecheck|type-check|webpack|vite|next|esbuild|rollup|turbo)\b/i;

function classifyBashStage(command: string): ExecStage | null {
  if (LINT_RE.test(command)) return "lint";
  if (TEST_RE.test(command)) return "test";
  if (BUILD_RE.test(command)) return "build";
  return null;
}

export function extractBashExecHints(content: string | ContentBlock[] | undefined): BashExecHint[] {
  if (!content || typeof content === "string" || !Array.isArray(content)) return [];
  const out: BashExecHint[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const name = block.name?.toLowerCase();
    if (name !== "bash") continue;
    const command = typeof block.input?.command === "string" ? block.input.command : "";
    const id = block.id;
    if (!id || !command) continue;
    const stage = classifyBashStage(command);
    if (stage) out.push({ toolUseId: id, command, stage });
  }
  return out;
}

function extractToolResults(content: string | ContentBlock[] | undefined): Array<{ toolUseId: string; isError: boolean }> {
  if (!content || typeof content === "string" || !Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; isError: boolean }> = [];
  for (const block of content) {
    if (block.type !== "tool_result" || !block.tool_use_id) continue;
    out.push({ toolUseId: block.tool_use_id, isError: block.is_error === true });
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

  if (raw.type === "ai-title" && raw.sessionId) {
    const title = (raw as unknown as Record<string, unknown>).aiTitle;
    if (typeof title === "string" && title.trim()) {
      return { kind: "ai-title", sessionHint: raw.sessionId, title: title.trim() };
    }
    return { kind: "skip" };
  }

  if (!raw.sessionId || !raw.uuid || !raw.timestamp) return { kind: "skip" };

  // Queued commands: messages sent by the user while the assistant is working.
  // Claude Code stores these as type:"attachment" with attachment.type:"queued_command".
  if (raw.type === "attachment") {
    const att = (raw as unknown as Record<string, unknown>).attachment as
      | { type?: string; prompt?: ContentBlock[] }
      | undefined;
    if (att?.type === "queued_command" && Array.isArray(att.prompt)) {
      const text = extractTextBlocks(att.prompt, ["text"]);
      if (text) {
        return {
          kind: "user-prompt",
          uuid: raw.uuid,
          sessionHint: raw.sessionId,
          text,
          timestamp: raw.timestamp,
        };
      }
    }
    return { kind: "skip" };
  }

  if (raw.type === "user") {
    // "user" entries include real prompts AND tool_result injections.
    // Real prompts have text blocks; tool_results have type:"tool_result".
    const text = extractTextBlocks(raw.message?.content, ["text"]);
    if (text) {
      return {
        kind: "user-prompt",
        uuid: raw.uuid,
        sessionHint: raw.sessionId,
        text,
        timestamp: raw.timestamp,
      };
    }
    const toolResults = extractToolResults(raw.message?.content);
    if (toolResults.length > 0) {
      return {
        kind: "tool-results",
        sessionHint: raw.sessionId,
        results: toolResults,
        timestamp: raw.timestamp,
      };
    }
    return { kind: "skip" };
  }

  if (raw.type === "assistant") {
    // Keep text blocks for scoring text; tool_use blocks get fingerprinted
    // separately so we can detect action-level churn (edit-revert, re-read,
    // bash-retry) that a pure-text similarity check can't see.
    const text = extractTextBlocks(raw.message?.content, ["text"]);
    const toolCalls = extractToolCalls(raw.message?.content);
    const fileEdits = extractFileEdits(raw.message?.content);
    const bashExecHints = extractBashExecHints(raw.message?.content);
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
      fileEdits,
      bashExecHints,
    };
  }

  return { kind: "skip" };
}
