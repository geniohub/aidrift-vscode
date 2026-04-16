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
  toolCalls: string[];
  model?: string;
  provider: "claude-code" | "codex";
  workspacePath?: string;
}

interface SessionDto {
  id: string;
  sessionHint: string | null;
  taskDescription: string;
  workspacePath: string | null;
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
const ASSISTANT_FLUSH_DEBOUNCE_MS = 1200;

export class SessionManager {
  /** sessionHint (Claude transcript UUID) → our Session.id */
  private readonly sessionBySH = new Map<string, string>();
  /** Pending turn being assembled per sessionHint */
  private readonly pending = new Map<string, PendingPair>();
  /** Debounced auto-flush timer per pending sessionHint */
  private readonly pendingFlushTimers = new Map<string, NodeJS.Timeout>();
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
    for (const timer of this.pendingFlushTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingFlushTimers.clear();
  }

  /**
   * Clears in-memory mapping/state so a new auth context (different user)
   * can safely re-ingest transcripts without stale session ids.
   */
  reset(): void {
    for (const timer of this.pendingFlushTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingFlushTimers.clear();
    this.sessionBySH.clear();
    this.pending.clear();
    this.lastTurn.clear();
    this.unsettled.clear();
    this.activeSessionId = null;
    this.activeTaskDescription = null;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getActiveTaskDescription(): string | null {
    return this.activeTaskDescription;
  }

  private cacheSession(session: SessionDto): string {
    if (session.sessionHint) this.sessionBySH.set(session.sessionHint, session.id);
    this.activeTaskDescription = session.taskDescription;
    return session.id;
  }

  private async findSessionByHint(sessionHint: string, workspacePath?: string): Promise<SessionDto | null> {
    const query = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : "";
    try {
      return await this.api.request<SessionDto>(`/sessions/by-hint/${encodeURIComponent(sessionHint)}${query}`);
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 404) return null;
      throw err;
    }
  }

  private async ensureSession(
    sessionHint: string,
    suggestedTask: string,
    provider: "claude-code" | "codex",
    workspacePath?: string,
  ): Promise<string> {
    const cached = this.sessionBySH.get(sessionHint);
    if (cached) return cached;
    const existing = await this.findSessionByHint(sessionHint, workspacePath);
    if (existing) return this.cacheSession(existing);

    const task = suggestedTask.slice(0, 200) || `${provider} session`;
    try {
      const created = await this.api.request<SessionDto>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          taskDescription: task,
          provider,
          sessionHint,
          autoCheckpointEnabled: true,
          workspacePath,
        }),
      });
      return this.cacheSession(created);
    } catch (createErr) {
      // A concurrent create (or prior collision resolved server-side) can make
      // the insert fail; re-read once by hint before surfacing the error.
      const raced = await this.findSessionByHint(sessionHint, workspacePath);
      if (raced) return this.cacheSession(raced);
      throw createErr;
    }
  }

  async handleEntry(
    entry: ParsedEntry,
    provider: "claude-code" | "codex" = "claude-code",
    workspacePath?: string,
  ): Promise<void> {
    if (entry.kind === "skip") return;
    const effectiveWorkspacePath = workspacePath ?? entry.workspacePath;

    if (entry.kind === "user-prompt") {
      // Bootstrap a session as soon as the first prompt is seen so tracking
      // appears immediately, even before the assistant reply is flushed.
      try {
        const sid = await this.ensureSession(
          entry.sessionHint,
          entry.text,
          provider,
          effectiveWorkspacePath,
        );
        this.activeSessionId = sid;
      } catch (err) {
        console.error("[aidrift] ensureSession bootstrap failed:", err);
      }

      // 1. Flush the previous user/assistant pair (if any) — this lands the turn.
      await this.flushPending(entry.sessionHint);

      // 2. Implicit-reject check against the last-posted turn in THIS session.
      await this.maybeImplicitReject(entry.sessionHint, entry.text);

      this.pending.set(entry.sessionHint, {
        userPromptText: entry.text,
        userPromptUuid: entry.uuid,
        assistantChunks: [],
        toolCalls: [],
        provider,
        workspacePath: effectiveWorkspacePath,
      });
      return;
    }

    // assistant-reply
    const p = this.pending.get(entry.sessionHint);
    if (!p) return;
    if (entry.text) p.assistantChunks.push(entry.text);
    if (entry.toolCalls.length > 0) p.toolCalls.push(...entry.toolCalls);
    if (entry.model) p.model = entry.model;
    // Debounced flush avoids waiting for the next user prompt before creating
    // the first tracked turn/session.
    this.schedulePendingFlush(entry.sessionHint);
  }

  private schedulePendingFlush(sessionHint: string): void {
    const prev = this.pendingFlushTimers.get(sessionHint);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.pendingFlushTimers.delete(sessionHint);
      void this.flushPending(sessionHint);
    }, ASSISTANT_FLUSH_DEBOUNCE_MS);
    this.pendingFlushTimers.set(sessionHint, timer);
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

  private async flushPending(sessionHint: string): Promise<void> {
    const timer = this.pendingFlushTimers.get(sessionHint);
    if (timer) {
      clearTimeout(timer);
      this.pendingFlushTimers.delete(sessionHint);
    }
    const p = this.pending.get(sessionHint);
    if (!p) return;
    if (p.assistantChunks.length === 0 && p.toolCalls.length === 0) return;
    const sessionId = await this.ensureSession(
      sessionHint,
      p.userPromptText,
      p.provider,
      p.workspacePath,
    );
    try {
      const turn = await this.api.request<{ id: string }>(`/sessions/${sessionId}/turns`, {
        method: "POST",
        body: JSON.stringify({
          userPrompt: p.userPromptText,
          modelResponse: p.assistantChunks.join("\n\n"),
          metadata: {
            source: `${p.provider}-jsonl`,
            userPromptUuid: p.userPromptUuid,
            model: p.model,
            toolCalls: p.toolCalls,
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
