// Owns the sessionHint → sessionId mapping and converts raw JSONL entries
// into API calls. Pairs user prompts with the concatenated text of the
// assistant replies that follow them, then applies implicit accept/reject
// heuristics so scoring actually fires during normal chat (the user
// shouldn't have to explicitly mark every turn).

import { similarity } from "./similarity";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApiError, type ApiClient } from "./api-client";
import type { Logger } from "./log";
import type {
  ParsedEntry,
  ParsedFileEdit,
  ExecStage,
  ParsedAgentSpawn,
} from "./watchers/jsonl-parser.js";

const execFileAsync = promisify(execFile);

// Cache of workspacePath → remote URL (resolved or null). Sessions created from
// the same workspace reuse the lookup; `git config` is cheap but called once
// per hint and we don't want to fan out on chatter.
const gitRepoUrlCache = new Map<string, Promise<string | null>>();

async function readGitRepoUrl(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd: workspacePath, timeout: 2000 },
    );
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

function getGitRepoUrl(workspacePath: string | undefined): Promise<string | null> {
  if (!workspacePath) return Promise.resolve(null);
  const cached = gitRepoUrlCache.get(workspacePath);
  if (cached) return cached;
  const pending = readGitRepoUrl(workspacePath);
  gitRepoUrlCache.set(workspacePath, pending);
  return pending;
}

interface PendingFileEdit extends ParsedFileEdit {
  occurredAt: string;
}

interface ExecutionEvent {
  stage: ExecStage;
  status: "pass" | "fail";
  createdAt: string;
}

interface PendingPair {
  userPromptText: string;
  userPromptUuid: string;
  assistantChunks: string[];
  toolCalls: string[];
  fileEdits: PendingFileEdit[];
  /** toolUseId → stage for bash commands that match lint/build/test. */
  bashExecHints: Map<string, ExecStage>;
  /** Execution events derived from pairing bash hints with tool results. */
  executionEvents: ExecutionEvent[];
  /** Agent/Task tool_use blocks seen in this turn. Posted as spawn ledger
   *  rows when the pending pair flushes so the parent turn id is known. */
  agentSpawns: ParsedAgentSpawn[];
  model?: string;
  provider: "claude-code" | "codex";
  workspacePath?: string;
  promptAt?: string;
  replyStartedAt?: string;
  replyCompletedAt?: string;
}

/** An Agent/Task spawn that has been posted to the server but hasn't yet
 *  been matched to a child session. Kept in an LRU keyed by the prompt
 *  prefix — the sub-agent's first user prompt is the Agent call's prompt
 *  argument verbatim, which is how we link. */
interface PendingSpawn {
  toolUseId: string;
  parentSessionId: string;
  promptPrefix: string;
  createdAt: number;
}

const SPAWN_MATCH_WINDOW_MS = 60 * 1000;
const SPAWN_PREFIX_LEN = 240;
const MAX_PENDING_SPAWNS = 200;
// Bound on spawn-toolUseIds we've observed locally. Used to gate the
// /agent-spawns/:id/complete PATCH so we don't fire one call per tool_result
// line during history re-ingest (most tool_results aren't Agent spawns).
const MAX_KNOWN_SPAWN_IDS = 500;
// Bound on spawn-toolUseIds already posted to /agent-spawns in this process.
// Prevents repeated POST floods when transcript lines are replayed.
const MAX_RECORDED_SPAWN_IDS = 1000;
// Bound on turn ids whose side-effects (file-edits, spawn post, unsettled
// queueing) have already been emitted in this process. Prevents replays of
// a deduped turn from repeatedly posting secondary writes.
const MAX_EMITTED_TURN_IDS = 2000;

interface SessionDto {
  id: string;
  sessionHint: string | null;
  taskDescription: string;
  workspacePath: string | null;
  gitRepoUrl?: string | null;
}

interface TurnSummary {
  id: string;
  userPrompt: string;
  postedAt: number; // ms since epoch
  outcomeSettled: boolean;
}

/** Stable key for matching an Agent/Task spawn's `prompt` to the sub-agent's
 *  first user prompt. Claude Code injects the prompt verbatim, but whitespace
 *  normalization + truncation protects against minor mangling. */
function normalizeSpawnPrefix(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SPAWN_PREFIX_LEN);
}

const REJECT_PATTERNS = /\b(no|nope|wrong|incorrect|actually|instead|still|broken|try again|not what|doesn[''`]t\s+work|didn[''`]t\s+work|not working|that[''`]?s wrong)\b/i;
const IMPLICIT_REJECT_SIMILARITY = 0.6;
const IMPLICIT_ACCEPT_MS = 5 * 60 * 1000; // 5 minutes
const SWEEP_INTERVAL_MS = 30 * 1000;
const ASSISTANT_FLUSH_DEBOUNCE_MS = 1200;
const AUTH_BACKOFF_MS = 30_000;
const SKIP_SESSION_SENTINEL = "__skip__";

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
  /** Most-recently-posted turn id per session id — used so spawn posting can
   *  attach to the right parent turn without refetching the session. */
  private readonly lastTurnIdByHint = new Map<string, string>();
  /** Turn ids for which we already emitted side-effects locally. */
  private readonly emittedTurnIds = new Set<string>();
  /** Pending Agent/Task spawns, keyed by prompt-prefix hash. When a new
   *  sub-agent session's first prompt matches one of these, we adopt the
   *  orphan as a child. LRU-capped. */
  private readonly pendingSpawns = new Map<string, PendingSpawn>();
  /** Adopted sessionHints, so we don't re-try adoption on every prompt. */
  private readonly adoptedHints = new Set<string>();
  /** Tool-use ids we've observed as Agent/Task spawns locally. Gates the
   *  spawn-complete PATCH so tool_results we didn't originate don't trigger
   *  one HTTP call each (which used to flood the API during history ingest). */
  private readonly knownSpawnToolUseIds = new Set<string>();
  /** Spawn ids that were already recorded via POST /agent-spawns in this run. */
  private readonly recordedSpawnToolUseIds = new Set<string>();
  /** In-flight POST /agent-spawns calls, keyed by toolUseId. */
  private readonly postingSpawnToolUseIds = new Set<string>();
  /** In-flight PATCH /agent-spawns/:toolUseId/complete calls. */
  private readonly completingSpawnToolUseIds = new Set<string>();
  private activeSessionId: string | null = null;
  private activeTaskDescription: string | null = null;
  private sweepTimer: NodeJS.Timeout | undefined;
  private metricsTimer: NodeJS.Timeout | undefined;
  private authBackoffUntil = 0;
  private authBackoffRetryTimer: NodeJS.Timeout | undefined;
  private authFailureNotified = false;
  private readonly metrics = {
    entriesUserPrompt: 0,
    entriesAssistantReply: 0,
    entriesToolResults: 0,
    flushCalls: 0,
    flushSuccess: 0,
    flushErrors: 0,
    turnPostCount: 0,
    turnPostMsTotal: 0,
    turnPostMsMax: 0,
    turnReplayDedup: 0,
    spawnPostAttempt: 0,
    spawnPostSkipRecorded: 0,
    spawnPostSkipInflight: 0,
    spawnPostSuccess: 0,
    spawnPostErrors: 0,
    spawnCompleteAttempt: 0,
    spawnCompleteSkipInflight: 0,
    spawnCompleteSuccess: 0,
    spawnCompleteErrors: 0,
    authBackoffs: 0,
  };

  constructor(
    private readonly api: ApiClient,
    private readonly log?: Logger,
    private readonly onAuthFailure?: () => void,
  ) {}

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweepForImplicitAccepts(), SWEEP_INTERVAL_MS);
    this.metricsTimer = setInterval(() => this.emitMetrics("tick"), 15_000);
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
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
    }
    this.emitMetrics("stop");
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
    this.lastTurnIdByHint.clear();
    this.emittedTurnIds.clear();
    this.pendingSpawns.clear();
    this.adoptedHints.clear();
    this.knownSpawnToolUseIds.clear();
    this.recordedSpawnToolUseIds.clear();
    this.postingSpawnToolUseIds.clear();
    this.completingSpawnToolUseIds.clear();
    this.activeSessionId = null;
    this.activeTaskDescription = null;
    this.authBackoffUntil = 0;
    this.authFailureNotified = false;
    if (this.authBackoffRetryTimer) {
      clearTimeout(this.authBackoffRetryTimer);
      this.authBackoffRetryTimer = undefined;
    }
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getActiveTaskDescription(): string | null {
    return this.activeTaskDescription;
  }

  /** Returns the id of the most recently posted turn (any session). */
  getLastTurnId(): string | null {
    if (!this.activeSessionId) return null;
    const last = this.lastTurn.get(this.activeSessionId);
    return last?.id ?? null;
  }

  /** Clears the cached active session id (e.g. after the API returns 404 for it). */
  clearActiveSession(): void {
    const stale = this.activeSessionId;
    this.activeSessionId = null;
    this.activeTaskDescription = null;
    // Drop any sessionHint→id mappings that point at the now-stale id so
    // the next entry triggers a fresh ensureSession lookup.
    if (stale) {
      for (const [hint, sid] of this.sessionBySH.entries()) {
        if (sid === stale) this.sessionBySH.delete(hint);
      }
      this.lastTurn.delete(stale);
    }
  }

  private cacheSession(session: SessionDto): string {
    if (session.sessionHint) this.sessionBySH.set(session.sessionHint, session.id);
    this.activeTaskDescription = session.taskDescription;
    return session.id;
  }

  private cachedSessionId(sessionHint: string): string | null {
    const sid = this.sessionBySH.get(sessionHint);
    if (!sid || sid === SKIP_SESSION_SENTINEL) return null;
    return sid;
  }

  // Fire-and-forget PATCH to fill Session.gitRepoUrl on a session created by
  // an older extension version. Server-side only writes when the column is
  // still null, so concurrent heals across devices can't stomp each other.
  private async backfillGitRepoUrl(sessionId: string, workspacePath: string): Promise<void> {
    try {
      const url = await getGitRepoUrl(workspacePath);
      if (!url) return;
      await this.api.request<SessionDto>(`/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ gitRepoUrl: url }),
      });
    } catch {
      // Silent — this is a best-effort cosmetic fill, never block the user.
    }
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
    startedAtHint?: string,
  ): Promise<string | null> {
    const cached = this.sessionBySH.get(sessionHint);
    if (cached === SKIP_SESSION_SENTINEL) return null;
    if (cached) return cached;
    if (this.isAuthBackoffActive()) return null;
    const existing = await this.findSessionByHint(sessionHint, workspacePath);
    if (existing) {
      // Self-heal: older extension versions (or create-by-cli) may have left
      // gitRepoUrl null. Fill it once from the workspace's remote so GitHub
      // links render in the dashboard.
      if (!existing.gitRepoUrl && workspacePath) {
        void this.backfillGitRepoUrl(existing.id, workspacePath);
      }
      return this.cacheSession(existing);
    }

    const task = suggestedTask.slice(0, 200) || `${provider} session`;
    const gitRepoUrl = await getGitRepoUrl(workspacePath);
    try {
      const created = await this.api.request<SessionDto>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          taskDescription: task,
          provider,
          sessionHint,
          autoCheckpointEnabled: true,
          workspacePath,
          ...(gitRepoUrl ? { gitRepoUrl } : {}),
          // Pin the session's startedAt to the first prompt's timestamp so
          // re-ingesting an old JSONL doesn't stamp it as "now" and reshuffle
          // the recent-sessions list.
          ...(startedAtHint ? { startedAt: startedAtHint } : {}),
        }),
      });
      return this.cacheSession(created);
    } catch (createErr) {
      const e = createErr as { status?: number };
      // 409 = sessionHint already belongs to another user — skip silently.
      if (e.status === 409) {
        this.sessionBySH.set(sessionHint, SKIP_SESSION_SENTINEL);
        return null;
      }
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

    if (entry.kind === "ai-title") {
      let sid = this.cachedSessionId(entry.sessionHint);
      if (!sid) {
        const existing = await this.findSessionByHint(entry.sessionHint);
        if (existing) sid = this.cacheSession(existing);
      }
      if (sid) {
        try {
          await this.api.request(`/sessions/${sid}`, {
            method: "PATCH",
            body: JSON.stringify({ taskDescription: entry.title }),
          });
        } catch {
          // Session title update is best-effort.
        }
      }
      return;
    }

    const effectiveWorkspacePath = workspacePath ?? ("workspacePath" in entry ? entry.workspacePath : undefined);

    if (entry.kind === "user-prompt") {
      this.metrics.entriesUserPrompt++;
      // Bootstrap a session as soon as the first prompt is seen so tracking
      // appears immediately, even before the assistant reply is flushed.
      try {
        const sid = await this.ensureSession(
          entry.sessionHint,
          entry.text,
          provider,
          effectiveWorkspacePath,
          entry.timestamp,
        );
        if (sid) this.activeSessionId = sid;
      } catch (err) {
        this.maybeApplyAuthBackoff(err, "user-prompt ensureSession");
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
        fileEdits: [],
        bashExecHints: new Map(),
        executionEvents: [],
        agentSpawns: [],
        provider,
        workspacePath: effectiveWorkspacePath,
        promptAt: entry.timestamp,
      });

      // Sub-agent adoption: if this is the first user prompt of a new
      // sessionHint AND it matches a recently-posted Agent spawn's prompt,
      // adopt this session as a child of the spawning parent. Fire-and-
      // forget — failure just leaves the session top-level.
      void this.tryAdoptAsChild(entry.sessionHint, entry.text);
      return;
    }

    // tool-results: pair with previously-seen bash hints to derive pass/fail,
    // and forward Agent/Task results to the spawn ledger.
    if (entry.kind === "tool-results") {
      this.metrics.entriesToolResults++;
      const p = this.pending.get(entry.sessionHint);
      if (!p) return;
      for (const r of entry.results) {
        const stage = p.bashExecHints.get(r.toolUseId);
        if (stage) {
          p.executionEvents.push({
            stage,
            status: r.isError ? "fail" : "pass",
            createdAt: entry.timestamp,
          });
          p.bashExecHints.delete(r.toolUseId);
          continue;
        }
        // Not a bash result — if it matches a pending Agent spawn, patch the
        // ledger row with the preview. Fire-and-forget; 404 = not ours.
        // Gate on the local known-spawns set: most tool_results are Read/Bash/
        // Edit and would 404 — without this gate, history re-ingest fires one
        // PATCH per tool_result and blows through the API rate limit.
        if (this.knownSpawnToolUseIds.has(r.toolUseId)) {
          void this.maybeCompleteSpawn(r.toolUseId, r.textPreview, r.isError);
        }
      }
      return;
    }

    // assistant-reply
    this.metrics.entriesAssistantReply++;
    const p = this.pending.get(entry.sessionHint);
    if (!p) return;
    if (entry.text) p.assistantChunks.push(entry.text);
    if (entry.toolCalls.length > 0) p.toolCalls.push(...entry.toolCalls);
    if (entry.fileEdits.length > 0) {
      for (const fe of entry.fileEdits) {
        p.fileEdits.push({ ...fe, occurredAt: entry.timestamp });
      }
    }
    for (const hint of entry.bashExecHints) {
      p.bashExecHints.set(hint.toolUseId, hint.stage);
    }
    if (entry.agentSpawns.length > 0) {
      p.agentSpawns.push(...entry.agentSpawns);
      for (const spawn of entry.agentSpawns) {
        if (this.knownSpawnToolUseIds.size >= MAX_KNOWN_SPAWN_IDS) {
          const oldest = this.knownSpawnToolUseIds.values().next().value;
          if (oldest !== undefined) this.knownSpawnToolUseIds.delete(oldest);
        }
        this.knownSpawnToolUseIds.add(spawn.toolUseId);
      }
    }
    if (entry.model) p.model = entry.model;
    // First assistant chunk sets "reply started"; every chunk advances
    // "reply completed" so the last one wins.
    if (!p.replyStartedAt) p.replyStartedAt = entry.timestamp;
    p.replyCompletedAt = entry.timestamp;
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

  /**
   * Flush every sessionHint with a pending pair, immediately — cancels
   * the debounce timers and awaits all POSTs. Used at the tail of a rescan
   * so we don't leave the last pair of each transcript dangling for 1.2s.
   */
  async drainPending(): Promise<void> {
    for (const timer of this.pendingFlushTimers.values()) clearTimeout(timer);
    this.pendingFlushTimers.clear();
    const hints = Array.from(this.pending.keys());
    await Promise.all(hints.map((h) => this.flushPending(h).catch(() => undefined)));
  }

  private async maybeImplicitReject(sessionHint: string, newPrompt: string): Promise<void> {
    const sessionId = this.cachedSessionId(sessionHint);
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
    this.metrics.flushCalls++;
    const timer = this.pendingFlushTimers.get(sessionHint);
    if (timer) {
      clearTimeout(timer);
      this.pendingFlushTimers.delete(sessionHint);
    }
    const p = this.pending.get(sessionHint);
    if (!p) return;
    if (p.assistantChunks.length === 0 && p.toolCalls.length === 0) return;
    let sessionId: string | null;
    try {
      sessionId = await this.ensureSession(
        sessionHint,
        p.userPromptText,
        p.provider,
        p.workspacePath,
        p.promptAt,
      );
    } catch (err) {
      this.maybeApplyAuthBackoff(err, "flush ensureSession");
      this.logFlushError("flush ensureSession", err);
      console.error("[aidrift] ensureSession in flush failed:", err);
      // Don't delete the pending pair — a transient error should be retried
      // on the next flush. But don't block the caller either.
      return;
    }
    if (!sessionId) {
      if (this.sessionBySH.get(sessionHint) === SKIP_SESSION_SENTINEL) {
        // Belongs to another user — drop the pending pair so it does not
        // accumulate forever.
        this.pending.delete(sessionHint);
      }
      // During auth backoff (or any transient ensureSession miss), keep the
      // pending pair so a later retry can upload it.
      return;
    }
    try {
      const t0 = Date.now();
      const turn = await this.api.request<{ id: string }>(`/sessions/${sessionId}/turns`, {
        method: "POST",
        body: JSON.stringify({
          userPrompt: p.userPromptText,
          modelResponse: p.assistantChunks.join("\n\n"),
          // Top-level: server uses promptAt to stamp Turn.createdAt (preserving
          // original chat order across re-ingests) and userPromptUuid to dedup
          // a re-ingested turn instead of inserting a duplicate.
          ...(p.promptAt ? { promptAt: p.promptAt } : {}),
          userPromptUuid: p.userPromptUuid,
          metadata: {
            source: `${p.provider}-jsonl`,
            userPromptUuid: p.userPromptUuid,
            model: p.model,
            toolCalls: p.toolCalls,
            timings: {
              promptAt: p.promptAt,
              replyStartedAt: p.replyStartedAt,
              replyCompletedAt: p.replyCompletedAt,
            },
            aiDrift: {
              ...(p.executionEvents.length > 0
                ? { executionEvents: p.executionEvents }
                : {}),
            },
          },
        }),
      });
      this.activeSessionId = sessionId;
      const turnPostMs = Date.now() - t0;
      this.metrics.turnPostCount++;
      this.metrics.turnPostMsTotal += turnPostMs;
      this.metrics.turnPostMsMax = Math.max(this.metrics.turnPostMsMax, turnPostMs);
      const seenTurnReplay = this.emittedTurnIds.has(turn.id);
      if (!seenTurnReplay) {
        if (this.emittedTurnIds.size >= MAX_EMITTED_TURN_IDS) {
          const oldest = this.emittedTurnIds.values().next().value;
          if (oldest !== undefined) this.emittedTurnIds.delete(oldest);
        }
        this.emittedTurnIds.add(turn.id);
      } else {
        this.metrics.turnReplayDedup++;
      }

      const existingLast = this.lastTurn.get(sessionId);
      if (!existingLast || existingLast.id !== turn.id) {
        this.lastTurn.set(sessionId, {
          id: turn.id,
          userPrompt: p.userPromptText,
          postedAt: Date.now(),
          outcomeSettled: false,
        });
      }
      this.lastTurnIdByHint.set(sessionHint, turn.id);
      if (!seenTurnReplay) {
        this.unsettled.set(turn.id, {
          sessionId,
          postedAt: Date.now(),
          userPrompt: p.userPromptText,
        });
      }
      // Fire-and-forget file-edits post; collision detection runs server-
      // side. Failures are non-fatal: scoring / turn tracking already
      // landed, this is supplementary signal.
      if (!seenTurnReplay && p.fileEdits.length > 0) {
        void this.postFileEdits(sessionId, turn.id, p.fileEdits);
      }
      // Sub-agent spawns: record one AgentSpawn per Task/Agent tool_use. The
      // ledger row is what later matches an orphan child JSONL. Non-fatal.
      if (!seenTurnReplay && p.agentSpawns.length > 0) {
        for (const spawn of p.agentSpawns) {
          void this.postAgentSpawn(sessionId, turn.id, spawn);
        }
      }
      this.metrics.flushSuccess++;
      this.clearAuthBackoff();
    } catch (err) {
      this.maybeApplyAuthBackoff(err, "post turn");
      this.metrics.flushErrors++;
      this.logFlushError("post turn", err);
      console.error("[aidrift] failed to post turn:", err);
    }
    this.pending.delete(sessionHint);
  }

  private async postFileEdits(
    sessionId: string,
    turnId: string,
    edits: PendingFileEdit[],
  ): Promise<void> {
    try {
      await this.api.request(`/sessions/${sessionId}/turns/${turnId}/file-edits`, {
        method: "POST",
        body: JSON.stringify({
          edits: edits.map((e) => ({
            filePath: e.filePath,
            editKind: e.editKind,
            occurredAt: e.occurredAt,
          })),
        }),
      });
    } catch (err) {
      console.error("[aidrift] failed to post file edits:", err);
    }
  }

  private async postAgentSpawn(
    parentSessionId: string,
    parentTurnId: string,
    spawn: ParsedAgentSpawn,
  ): Promise<void> {
    this.metrics.spawnPostAttempt++;
    if (this.recordedSpawnToolUseIds.has(spawn.toolUseId)) {
      this.metrics.spawnPostSkipRecorded++;
      return;
    }
    if (this.postingSpawnToolUseIds.has(spawn.toolUseId)) {
      this.metrics.spawnPostSkipInflight++;
      return;
    }
    this.postingSpawnToolUseIds.add(spawn.toolUseId);
    try {
      await this.api.request(`/agent-spawns`, {
        method: "POST",
        body: JSON.stringify({
          parentSessionId,
          parentTurnId,
          toolUseId: spawn.toolUseId,
          agentType: spawn.agentType,
          prompt: spawn.prompt,
          description: spawn.description,
        }),
      });
      if (this.recordedSpawnToolUseIds.size >= MAX_RECORDED_SPAWN_IDS) {
        const oldest = this.recordedSpawnToolUseIds.values().next().value;
        if (oldest !== undefined) this.recordedSpawnToolUseIds.delete(oldest);
      }
      this.recordedSpawnToolUseIds.add(spawn.toolUseId);
      this.metrics.spawnPostSuccess++;
      // Remember the prompt prefix so we can adopt an orphan child later.
      const key = normalizeSpawnPrefix(spawn.prompt);
      if (this.pendingSpawns.size >= MAX_PENDING_SPAWNS) {
        // LRU eviction: drop the oldest entry.
        const oldestKey = this.pendingSpawns.keys().next().value;
        if (oldestKey) this.pendingSpawns.delete(oldestKey);
      }
      this.pendingSpawns.set(key, {
        toolUseId: spawn.toolUseId,
        parentSessionId,
        promptPrefix: key,
        createdAt: Date.now(),
      });
    } catch (err) {
      const e = err as { status?: number };
      // 404/409 — parent turn disappeared or duplicate; not fatal.
      if (e.status === 404 || e.status === 409) {
        if (e.status === 409) {
          // Idempotent duplicate on server: treat as recorded so replays
          // don't keep posting this same spawn id.
          if (this.recordedSpawnToolUseIds.size >= MAX_RECORDED_SPAWN_IDS) {
            const oldest = this.recordedSpawnToolUseIds.values().next().value;
            if (oldest !== undefined) this.recordedSpawnToolUseIds.delete(oldest);
          }
          this.recordedSpawnToolUseIds.add(spawn.toolUseId);
        }
        this.metrics.spawnPostSuccess++;
        return;
      }
      this.metrics.spawnPostErrors++;
      console.error("[aidrift] failed to post agent spawn:", err);
    } finally {
      this.postingSpawnToolUseIds.delete(spawn.toolUseId);
    }
  }

  private async maybeCompleteSpawn(
    toolUseId: string,
    resultPreview: string | undefined,
    isError: boolean,
  ): Promise<void> {
    this.metrics.spawnCompleteAttempt++;
    if (this.completingSpawnToolUseIds.has(toolUseId)) {
      this.metrics.spawnCompleteSkipInflight++;
      return;
    }
    this.completingSpawnToolUseIds.add(toolUseId);
    try {
      await this.api.request(`/agent-spawns/${encodeURIComponent(toolUseId)}/complete`, {
        method: "PATCH",
        body: JSON.stringify({
          resultPreview: resultPreview ?? null,
          resultIsError: isError,
        }),
      });
      this.knownSpawnToolUseIds.delete(toolUseId);
      this.metrics.spawnCompleteSuccess++;
    } catch (err) {
      const e = err as { status?: number };
      // 404 = not an Agent spawn (e.g. a Read/Bash tool_result). Silent.
      if (e.status === 404) {
        this.knownSpawnToolUseIds.delete(toolUseId);
        this.metrics.spawnCompleteSuccess++;
        return;
      }
      this.metrics.spawnCompleteErrors++;
      console.error("[aidrift] failed to complete agent spawn:", err);
    } finally {
      this.completingSpawnToolUseIds.delete(toolUseId);
    }
  }

  private async tryAdoptAsChild(sessionHint: string, firstPrompt: string): Promise<void> {
    if (this.adoptedHints.has(sessionHint)) return;
    const key = normalizeSpawnPrefix(firstPrompt);
    const match = this.pendingSpawns.get(key);
    if (!match) return;
    // Proximity guard: don't adopt if the spawn was recorded long ago.
    if (Date.now() - match.createdAt > SPAWN_MATCH_WINDOW_MS) {
      this.pendingSpawns.delete(key);
      return;
    }
    // Resolve the child session id (may not be cached yet — the user-prompt
    // path bootstraps the session before calling us).
    const childId = this.sessionBySH.get(sessionHint);
    if (!childId || childId === SKIP_SESSION_SENTINEL) return;
    try {
      await this.api.request(`/sessions/${childId}/adopt-as-child`, {
        method: "POST",
        body: JSON.stringify({
          parentSessionId: match.parentSessionId,
          spawnToolUseId: match.toolUseId,
        }),
      });
      this.adoptedHints.add(sessionHint);
      this.pendingSpawns.delete(key);
    } catch (err) {
      const e = err as { status?: number };
      // 409 (already linked) or 404 (spawn gone) — stop trying for this hint.
      if (e.status === 409 || e.status === 404) {
        this.adoptedHints.add(sessionHint);
        this.pendingSpawns.delete(key);
        return;
      }
      console.error("[aidrift] adopt-as-child failed:", err);
    }
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

  private emitMetrics(reason: string): void {
    if (!this.log) return;
    const active =
      this.metrics.entriesUserPrompt +
      this.metrics.entriesAssistantReply +
      this.metrics.entriesToolResults +
      this.metrics.flushCalls +
      this.metrics.spawnPostAttempt +
      this.metrics.spawnCompleteAttempt;
    if (active === 0) return;
    this.log.info("session manager stats", {
      reason,
      ...this.metrics,
      turnPostMsAvg:
        this.metrics.turnPostCount > 0
          ? Math.round(this.metrics.turnPostMsTotal / this.metrics.turnPostCount)
          : 0,
      unsettledTurns: this.unsettled.size,
      pendingPairs: this.pending.size,
      knownSpawnIds: this.knownSpawnToolUseIds.size,
      postingSpawnIds: this.postingSpawnToolUseIds.size,
      completingSpawnIds: this.completingSpawnToolUseIds.size,
    });
    for (const key of Object.keys(this.metrics) as Array<keyof typeof this.metrics>) {
      this.metrics[key] = 0;
    }
  }

  private isAuthBackoffActive(): boolean {
    return Date.now() < this.authBackoffUntil;
  }

  private maybeApplyAuthBackoff(err: unknown, phase: string): void {
    if (!(err instanceof ApiError) || err.status !== 401) return;
    const wasInBackoff = this.isAuthBackoffActive();
    const until = Date.now() + AUTH_BACKOFF_MS;
    if (until > this.authBackoffUntil) this.authBackoffUntil = until;
    this.metrics.authBackoffs++;
    this.log?.warn("session manager auth backoff", {
      phase,
      backoffMs: AUTH_BACKOFF_MS,
    });
    if (!wasInBackoff && !this.authFailureNotified) {
      this.authFailureNotified = true;
      this.onAuthFailure?.();
    }
    if (this.authBackoffRetryTimer) clearTimeout(this.authBackoffRetryTimer);
    this.authBackoffRetryTimer = setTimeout(() => {
      this.authBackoffRetryTimer = undefined;
      if (this.isAuthBackoffActive()) return;
      for (const hint of this.pending.keys()) {
        void this.flushPending(hint);
      }
    }, AUTH_BACKOFF_MS + 500);
  }

  private clearAuthBackoff(): void {
    if (this.authBackoffUntil === 0 && !this.authFailureNotified) return;
    this.authBackoffUntil = 0;
    this.authFailureNotified = false;
    if (this.authBackoffRetryTimer) {
      clearTimeout(this.authBackoffRetryTimer);
      this.authBackoffRetryTimer = undefined;
    }
  }

  private logFlushError(phase: string, err: unknown): void {
    const e = err as { status?: number; message?: string; name?: string };
    this.log?.error("session manager flush error", {
      phase,
      status: e.status,
      name: e.name,
      message: e.message ?? String(err),
    });
  }
}
