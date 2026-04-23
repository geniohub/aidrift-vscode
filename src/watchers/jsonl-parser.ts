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
  /**
   * Agent/Task sub-agent spawns extracted from this assistant message. Each
   * entry is one `Task`/`Agent` tool_use block. The session manager uses
   * these to: (1) post spawn ledger rows, and (2) match incoming child
   * sessions by prompt-prefix hash.
   */
  agentSpawns: ParsedAgentSpawn[];
}

/**
 * One Agent/Task tool_use from Claude Code. `prompt` is the sub-agent's
 * stated purpose — the same string Claude Code injects as the sub-agent's
 * first user prompt, which is how we later match an orphan JSONL to its
 * parent. Guard both `task` and `agent` tool names for version robustness.
 */
export interface ParsedAgentSpawn {
  toolUseId: string;
  agentType: string | null;
  description: string | null;
  prompt: string;
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
  results: Array<{ toolUseId: string; isError: boolean; textPreview?: string }>;
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
  content?: string | ContentBlock[];
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
  isSidechain?: boolean;
}

const CONTEXT_TAG_RE = /<(?:ide_[a-z_]+|system-reminder|environment_context|context|status|instructions|local-command-(?:caveat|stdout|stderr)|command-(?:name|message|args|stdout|stderr))>[\s\S]*?<\/(?:ide_[a-z_]+|system-reminder|environment_context|context|status|instructions|local-command-(?:caveat|stdout|stderr)|command-(?:name|message|args|stdout|stderr))>/gi;

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
    case "task":
    case "agent": {
      const promptRaw = typeof input.prompt === "string" ? input.prompt : null;
      return promptRaw ? `task:${norm(promptRaw)}` : null;
    }
    default:
      return null;
  }
}

/**
 * Extract Agent/Task sub-agent spawns from an assistant message. Guards
 * both tool names — Claude Code has shifted between `Task` and `Agent`
 * across builds — so we stay robust.
 */
export function extractAgentSpawns(
  content: string | ContentBlock[] | undefined,
): ParsedAgentSpawn[] {
  if (!content || typeof content === "string" || !Array.isArray(content)) return [];
  const out: ParsedAgentSpawn[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const name = block.name?.toLowerCase();
    if (name !== "task" && name !== "agent") continue;
    const id = block.id;
    const input = block.input ?? {};
    const prompt = typeof input.prompt === "string" ? input.prompt : null;
    if (!id || !prompt) continue;
    const description =
      typeof input.description === "string" ? input.description : null;
    const agentType =
      typeof input.subagent_type === "string"
        ? input.subagent_type
        : typeof input.agent_type === "string"
          ? input.agent_type
          : null;
    out.push({ toolUseId: id, agentType, description, prompt });
  }
  return out;
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

// Order matters: more-specific patterns (e.g. `npm run test`) must match before
// a generic keyword like `build` in `npm run build`. We evaluate lint → test →
// build so `cargo test` lands in TEST, `make test` lands in TEST, `make` alone
// falls through to BUILD, etc.
const LINT_RE =
  /\b(lint|eslint|prettier|stylelint|biome|ruff|mypy|flake8|pylint|black|rubocop|shellcheck|gofmt|clippy|cargo\s+fmt|cargo\s+clippy)\b/i;
const TEST_RE =
  /\b(test|vitest|jest|mocha|pytest|spec|cypress|playwright|phpunit|rspec|go\s+test|cargo\s+test|bun\s+test|deno\s+test)\b/i;
const BUILD_RE =
  /\b(build|compile|bundle|tsc|typecheck|type-check|webpack|vite|next|esbuild|rollup|turbo|make|gradle|mvn|maven|sbt|go\s+build|go\s+vet|cargo\s+build|cargo\s+check|dotnet\s+build|bun\s+build)\b/i;

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

const TOOL_RESULT_PREVIEW_CHARS = 2048;

function extractToolResults(
  content: string | ContentBlock[] | undefined,
): Array<{ toolUseId: string; isError: boolean; textPreview?: string }> {
  if (!content || typeof content === "string" || !Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; isError: boolean; textPreview?: string }> = [];
  for (const block of content) {
    if (block.type !== "tool_result" || !block.tool_use_id) continue;
    // Preserve the result text (trimmed) so the session-manager can archive
    // it on an AgentSpawn ledger row. Matching up to an Agent spawn happens
    // upstream; we always extract the preview (cheap) and let the consumer
    // decide whether to keep it.
    const raw =
      typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? (block.content as ContentBlock[])
              .map((b) => (b.type === "text" ? b.text : null))
              .filter((x): x is string => !!x)
              .join("\n")
          : undefined;
    const textPreview = raw ? raw.slice(0, TOOL_RESULT_PREVIEW_CHARS) : undefined;
    out.push({
      toolUseId: block.tool_use_id,
      isError: block.is_error === true,
      ...(textPreview ? { textPreview } : {}),
    });
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

  // Sub-agent (Task/Agent) transcripts live in {parent}/subagents/*.jsonl and
  // carry the parent's sessionId, so their entries would otherwise be posted
  // against the parent's server session. Skip until nested tracking lands.
  if (raw.isSidechain === true) return { kind: "skip" };

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
    const agentSpawns = extractAgentSpawns(raw.message?.content);
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
      agentSpawns,
    };
  }

  return { kind: "skip" };
}
