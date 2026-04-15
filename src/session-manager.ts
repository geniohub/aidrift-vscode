// Owns the sessionHint → sessionId mapping and converts raw JSONL entries
// into API calls. Pairs user prompts with the concatenated text of the
// assistant replies that follow them (until the next user prompt).

import type { ApiClient } from "./api-client";
import type { ParsedEntry } from "./watchers/jsonl-parser.js";

interface PendingPair {
  userPromptText: string;
  userPromptUuid: string;
  assistantChunks: string[];
  model?: string;
}

interface SessionDto {
  id: string;
  sessionHint: string | null;
  taskDescription: string;
}

export class SessionManager {
  /** sessionHint (Claude transcript UUID) → our Session.id */
  private readonly sessionBySH = new Map<string, string>();
  /** Pending turn being assembled per sessionHint */
  private readonly pending = new Map<string, PendingPair>();
  /** Most-recent session id we saw activity on */
  private activeSessionId: string | null = null;
  private activeTaskDescription: string | null = null;

  constructor(private readonly api: ApiClient) {}

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getActiveTaskDescription(): string | null {
    return this.activeTaskDescription;
  }

  /**
   * Ensure a Session row exists for this Claude Code transcript UUID.
   * Returns our Session.id. Uses `first user prompt truncated` as the
   * task description when auto-creating.
   */
  private async ensureSession(sessionHint: string, suggestedTask: string): Promise<string> {
    const cached = this.sessionBySH.get(sessionHint);
    if (cached) return cached;
    // Look up on server
    try {
      const existing = await this.api.request<SessionDto>(`/sessions/by-hint/${encodeURIComponent(sessionHint)}`);
      this.sessionBySH.set(sessionHint, existing.id);
      this.activeTaskDescription = existing.taskDescription;
      return existing.id;
    } catch (err) {
      const e = err as { status?: number };
      if (e.status !== 404) throw err;
    }
    // Create
    const task = suggestedTask.slice(0, 200) || "Claude Code session";
    const created = await this.api.request<SessionDto>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        taskDescription: task,
        provider: "claude-code",
        sessionHint,
        autoCheckpointEnabled: true,
      }),
    });
    this.sessionBySH.set(sessionHint, created.id);
    this.activeTaskDescription = created.taskDescription;
    return created.id;
  }

  async handleEntry(entry: ParsedEntry): Promise<void> {
    if (entry.kind === "skip") return;

    if (entry.kind === "user-prompt") {
      // Flush any pending pair first (assistant replies without a following user
      // prompt won't get flushed until this call — which is fine because the
      // transcript is append-only).
      await this.flushPending(entry.sessionHint);

      this.pending.set(entry.sessionHint, {
        userPromptText: entry.text,
        userPromptUuid: entry.uuid,
        assistantChunks: [],
      });
      return;
    }

    // assistant-reply
    const p = this.pending.get(entry.sessionHint);
    if (!p) return; // orphan assistant reply — ignore
    p.assistantChunks.push(entry.text);
    if (entry.model) p.model = entry.model;
  }

  /**
   * Flush + POST any pending user/assistant pair for this transcript.
   * Called when a new user prompt arrives (end of previous turn) and
   * could be called on a timer in v2 to land trailing assistant replies.
   */
  private async flushPending(sessionHint: string): Promise<void> {
    const p = this.pending.get(sessionHint);
    if (!p) return;
    if (p.assistantChunks.length === 0) return; // no reply yet, keep pending
    const sessionId = await this.ensureSession(sessionHint, p.userPromptText);
    try {
      await this.api.request(`/sessions/${sessionId}/turns`, {
        method: "POST",
        body: JSON.stringify({
          userPrompt: p.userPromptText,
          modelResponse: p.assistantChunks.join("\n\n"),
          metadata: {
            source: "claude-code-jsonl",
            userPromptUuid: p.userPromptUuid,
            model: p.model,
          },
        }),
      });
      this.activeSessionId = sessionId;
    } catch (err) {
      console.error("[aidrift] failed to post turn:", err);
    }
    this.pending.delete(sessionHint);
  }
}
