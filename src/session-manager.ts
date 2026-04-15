// Owns the sessionHint → sessionId mapping and converts raw JSONL entries
// into API calls. Pairs user prompts with the concatenated text of the
// assistant replies that follow them, then applies implicit accept/reject
// heuristics so scoring actually fires during normal chat (the user
// shouldn't have to explicitly mark every turn).

import { similarity } from "@aidrift/core";
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

interface TurnSummary {
  id: string;
  userPrompt: string;
  postedAt: number; // ms since epoch
  outcomeSettled: boolean;
}

const REJECT_PATTERNS = /\b(no|nope|wrong|incorrect|actually|instead|still|broken|try again|not what|doesn[''`]t\s+work|didn[''`]t\s+work|not working|that[''`]?s wrong)\b/i;
const IMPLICIT_REJECT_SIMILARITY = 0.6;
const IMPLICIT_ACCEPT_MS = 5 * 60 * 1000; // 5 minutes
const SWEEP_INTERVAL_MS = 30 * 1000;

export class SessionManager {
  /** sessionHint (Claude transcript UUID) → our Session.id */
  private readonly sessionBySH = new Map<string, string>();
  /** Pending turn being assembled per sessionHint */
  private readonly pending = new Map<string, PendingPair>();
  /** Most-recent unsettled turn per sessionId, used for implicit outcomes */
  private readonly lastTurn = new Map<string, TurnSummary>();
  /** Recently-seen turn ids (with their session) for the acceptTimer sweep */
  private readonly unsettled = new Map<string, { sessionId: string; postedAt: number; userPrompt: string }>();
  private activeSessionId: string | null = null;
  private activeTaskDescription: string | null = null;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly api: ApiClient) {}

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweepForImplicitAccepts(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getActiveTaskDescription(): string | null {
    return this.activeTaskDescription;
  }

  private async ensureSession(sessionHint: string, suggestedTask: string, provider: "claude-code" | "codex"): Promise<string> {
    const cached = this.sessionBySH.get(sessionHint);
    if (cached) return cached;
    try {
      const existing = await this.api.request<SessionDto>(`/sessions/by-hint/${encodeURIComponent(sessionHint)}`);
      this.sessionBySH.set(sessionHint, existing.id);
      this.activeTaskDescription = existing.taskDescription;
      return existing.id;
    } catch (err) {
      const e = err as { status?: number };
      if (e.status !== 404) throw err;
    }
    const task = suggestedTask.slice(0, 200) || `${provider} session`;
    const created = await this.api.request<SessionDto>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        taskDescription: task,
        provider,
        sessionHint,
        autoCheckpointEnabled: true,
      }),
    });
    this.sessionBySH.set(sessionHint, created.id);
    this.activeTaskDescription = created.taskDescription;
    return created.id;
  }

  async handleEntry(entry: ParsedEntry, provider: "claude-code" | "codex" = "claude-code"): Promise<void> {
    if (entry.kind === "skip") return;

    if (entry.kind === "user-prompt") {
      // 1. Flush the previous user/assistant pair (if any) — this lands the turn.
      await this.flushPending(entry.sessionHint, provider);

      // 2. Implicit-reject check against the last-posted turn in THIS session.
      await this.maybeImplicitReject(entry.sessionHint, entry.text);

      this.pending.set(entry.sessionHint, {
        userPromptText: entry.text,
        userPromptUuid: entry.uuid,
        assistantChunks: [],
      });
      return;
    }

    // assistant-reply
    const p = this.pending.get(entry.sessionHint);
    if (!p) return;
    p.assistantChunks.push(entry.text);
    if (entry.model) p.model = entry.model;
  }

  private async maybeImplicitReject(sessionHint: string, newPrompt: string): Promise<void> {
    const sessionId = this.sessionBySH.get(sessionHint);
    if (!sessionId) return;
    const last = this.lastTurn.get(sessionId);
    if (!last || last.outcomeSettled) return;

    const looksRejected =
      REJECT_PATTERNS.test(newPrompt) ||
      similarity(last.userPrompt, newPrompt) > IMPLICIT_REJECT_SIMILARITY;
    if (!looksRejected) return;

    try {
      await this.api.request(`/turns/${last.id}/outcome`, {
        method: "PATCH",
        body: JSON.stringify({ outcome: "rejected", source: "implicit", note: "auto: re-prompt within session" }),
      });
      last.outcomeSettled = true;
      this.unsettled.delete(last.id);
    } catch (err) {
      console.error("[aidrift] implicit-reject PATCH failed:", err);
    }
  }

  private async flushPending(sessionHint: string, provider: "claude-code" | "codex"): Promise<void> {
    const p = this.pending.get(sessionHint);
    if (!p) return;
    if (p.assistantChunks.length === 0) return;
    const sessionId = await this.ensureSession(sessionHint, p.userPromptText, provider);
    try {
      const turn = await this.api.request<{ id: string }>(`/sessions/${sessionId}/turns`, {
        method: "POST",
        body: JSON.stringify({
          userPrompt: p.userPromptText,
          modelResponse: p.assistantChunks.join("\n\n"),
          metadata: {
            source: `${provider}-jsonl`,
            userPromptUuid: p.userPromptUuid,
            model: p.model,
          },
        }),
      });
      this.activeSessionId = sessionId;
      this.lastTurn.set(sessionId, {
        id: turn.id,
        userPrompt: p.userPromptText,
        postedAt: Date.now(),
        outcomeSettled: false,
      });
      this.unsettled.set(turn.id, { sessionId, postedAt: Date.now(), userPrompt: p.userPromptText });
    } catch (err) {
      console.error("[aidrift] failed to post turn:", err);
    }
    this.pending.delete(sessionHint);
  }

  /**
   * Sweep turns older than 5 minutes with no follow-up → implicit-accept.
   * This is what makes scoring work during normal chat: turns that don't
   * trigger an implicit-reject get accepted once the user has clearly
   * moved on.
   */
  private async sweepForImplicitAccepts(): Promise<void> {
    const cutoff = Date.now() - IMPLICIT_ACCEPT_MS;
    const toAccept: Array<{ turnId: string; sessionId: string }> = [];
    for (const [turnId, info] of this.unsettled.entries()) {
      if (info.postedAt > cutoff) continue;
      toAccept.push({ turnId, sessionId: info.sessionId });
    }
    for (const { turnId, sessionId } of toAccept) {
      try {
        await this.api.request(`/turns/${turnId}/outcome`, {
          method: "PATCH",
          body: JSON.stringify({ outcome: "accepted", source: "implicit", note: "auto: no follow-up within 5 min" }),
        });
        this.unsettled.delete(turnId);
        const last = this.lastTurn.get(sessionId);
        if (last && last.id === turnId) last.outcomeSettled = true;
      } catch (err) {
        const e = err as { status?: number };
        // 404 = turn was deleted / session gone: drop it silently.
        if (e.status === 404) {
          this.unsettled.delete(turnId);
          continue;
        }
        console.error("[aidrift] implicit-accept PATCH failed:", err);
      }
    }
  }
}
