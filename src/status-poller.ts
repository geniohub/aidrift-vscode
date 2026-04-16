// Polls GET /sessions/:id/status for the active session and updates the
// VSCode status bar. Fires a one-shot notification when a drift alert
// first transitions to active.

import * as vscode from "vscode";
import { ApiError, type ApiClient } from "./api-client";

interface StatusDto {
  session: { id: string; taskDescription: string };
  currentScore: number | null;
  trend: "improving" | "stable" | "drifting";
  turnCount: number;
  alert: {
    active: boolean;
    reasons: string[];
    likelyDriftStartTurnId: string | null;
    type: "none" | "infra" | "tool_churn" | "stuck_loop" | "rejection_cascade" | "misalignment" | "gradual_decay";
    recommendation: string | null;
  };
  lastStableCheckpoint: { turnId: string; summary: string; scoreAtCheckpoint: number } | null;
}

interface TrackingHealthDto {
  workspacePath: string | null;
  hasRecentActivity: boolean;
  turnsLast24h: number;
  lastTurnAt: string | null;
  recommendations: string[];
}

function formatIdleLabel(lastTurnAt: string | null): string {
  if (!lastTurnAt) return "no turns yet";
  const deltaMs = Date.now() - new Date(lastTurnAt).getTime();
  if (deltaMs < 0) return "";
  const min = Math.floor(deltaMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export class StatusPoller {
  private timer: NodeJS.Timeout | undefined;
  private lastAlertActive = false;
  private lastStatus: StatusDto | null = null;
  private lastTracking: TrackingHealthDto | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly statusBar: vscode.StatusBarItem,
    private readonly getActiveSessionId: () => string | null,
    private readonly getActiveTaskDescription: () => string | null,
    private readonly getWorkspacePath: () => string | undefined,
    private readonly onStaleActiveSession: () => void = () => {},
  ) {}

  start(): void {
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  getLastStatus(): StatusDto | null {
    return this.lastStatus;
  }

  getLastTracking(): TrackingHealthDto | null {
    return this.lastTracking;
  }

  private scheduleNext(): void {
    const intervalSec = vscode.workspace
      .getConfiguration("aidrift")
      .get<number>("statusPollIntervalSeconds", 30);
    this.timer = setTimeout(() => void this.tick(), Math.max(5, intervalSec) * 1000);
  }

  private async tick(): Promise<void> {
    try {
      const sessionId = this.getActiveSessionId();
      if (!sessionId) {
        const task = this.getActiveTaskDescription();
        if (!(await this.api.isSignedIn())) {
          this.statusBar.text = "$(account) Drift: sign in";
          this.statusBar.command = "aidrift.login";
          this.statusBar.tooltip = "Click to sign in to AI Drift";
          this.statusBar.backgroundColor = undefined;
        } else {
          const tracking = await this.fetchTrackingHealth();
          const recent = tracking?.hasRecentActivity ?? false;
          const idleLabel = formatIdleLabel(tracking?.lastTurnAt ?? null);
          this.statusBar.text = recent
            ? "$(pulse) Drift: watching"
            : `$(warning) Drift: idle${idleLabel ? ` · ${idleLabel}` : ""}`;
          this.statusBar.command = "aidrift.openActiveInDashboard";
          this.statusBar.tooltip = this.trackingTooltip(tracking);
          this.statusBar.backgroundColor = recent
            ? undefined
            : new vscode.ThemeColor("statusBarItem.warningBackground");
        }
        return;
      }

      const tracking = await this.fetchTrackingHealth();
      const status = await this.api.request<StatusDto>(`/sessions/${sessionId}/status`);
      this.lastStatus = status;
      this.render(status, tracking);
      this.maybeNotify(status);
    } catch (err) {
      // 404 = stale active session id (e.g. it was deleted). Just clear the
      // status; don't pretend the API is down.
      if (err instanceof ApiError && err.status === 404) {
        this.onStaleActiveSession();
        this.lastStatus = null;
        this.statusBar.text = "$(pulse) Drift: watching";
        this.statusBar.tooltip = "Active session no longer exists.";
        this.statusBar.backgroundColor = undefined;
      } else if (err instanceof ApiError && err.status === 401) {
        this.statusBar.text = "$(account) Drift: sign in";
        this.statusBar.command = "aidrift.login";
        this.statusBar.tooltip = "AI Drift session expired — sign in again.";
        this.statusBar.backgroundColor = undefined;
      } else {
        this.statusBar.text = "$(warning) Drift: api?";
        this.statusBar.tooltip = `AI Drift API unreachable: ${(err as Error).message}`;
        this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      }
    } finally {
      this.scheduleNext();
    }
  }

  private render(status: StatusDto, tracking: TrackingHealthDto | null): void {
    const score = status.currentScore;
    const trendArrow = status.trend === "improving" ? "↗" : status.trend === "drifting" ? "↘" : "→";
    const trackingBadge = tracking?.hasRecentActivity ? "·$(pass)" : "·$(warning)";
    if (score === null) {
      this.statusBar.text = `$(pulse) Drift — ${trendArrow} ${trackingBadge}`;
    } else {
      const icon =
        score >= 80 ? "$(pulse)" :
        score >= 65 ? "$(alert)" :
        "$(flame)";
      this.statusBar.text = `${icon} Drift ${score} ${trendArrow} ${trackingBadge}`;
    }
    this.statusBar.command = "aidrift.openActiveInDashboard";
    this.statusBar.tooltip = new vscode.MarkdownString(
      [
        `**${status.session.taskDescription}**`,
        ``,
        `Score: ${score ?? "—"} · Trend: ${status.trend} · Turns: ${status.turnCount}`,
        status.alert.active
          ? `\n\n⚠ **Drift alert** _(${status.alert.type})_\n\n${status.alert.reasons.map((r) => `- ${r}`).join("\n")}${status.alert.recommendation ? `\n\n→ ${status.alert.recommendation}` : ""}`
          : "",
        status.lastStableCheckpoint
          ? `\n\nLast stable checkpoint: _${status.lastStableCheckpoint.summary}_ (score ${status.lastStableCheckpoint.scoreAtCheckpoint})`
          : "",
        tracking
          ? `\n\nTracking: **${tracking.hasRecentActivity ? "ok" : "stale"}**` +
            `\n\nTurns (24h): ${tracking.turnsLast24h}` +
            `${tracking.lastTurnAt ? `\n\nLast turn: ${new Date(tracking.lastTurnAt).toLocaleString()}` : ""}` +
            `${tracking.recommendations.length > 0 ? `\n\n${tracking.recommendations.map((r) => `- ${r}`).join("\n")}` : ""}`
          : "",
      ].join(""),
    );
    this.statusBar.backgroundColor = status.alert.active
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : tracking && !tracking.hasRecentActivity
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }

  private async fetchTrackingHealth(): Promise<TrackingHealthDto | null> {
    try {
      const workspace = this.getWorkspacePath();
      const query = workspace ? `?workspacePath=${encodeURIComponent(workspace)}` : "";
      const tracking = await this.api.request<TrackingHealthDto>(`/tracking/health${query}`);
      this.lastTracking = tracking;
      return tracking;
    } catch {
      return this.lastTracking;
    }
  }

  private trackingTooltip(tracking: TrackingHealthDto | null): string {
    if (!tracking) return "AI Drift — tracking status unavailable";
    return [
      `AI Drift — tracking ${tracking.hasRecentActivity ? "ok" : "stale"}`,
      `Turns (24h): ${tracking.turnsLast24h}`,
      tracking.lastTurnAt ? `Last turn: ${new Date(tracking.lastTurnAt).toLocaleString()}` : "Last turn: none",
      ...(tracking.recommendations ?? []),
    ].join("\n");
  }

  private maybeNotify(status: StatusDto): void {
    if (!status.alert.active) {
      this.lastAlertActive = false;
      return;
    }
    if (this.lastAlertActive) return; // already notified for this alert window
    this.lastAlertActive = true;

    const hasCheckpoint = !!status.lastStableCheckpoint;
    const summary = status.lastStableCheckpoint
      ? `Last stable checkpoint: "${status.lastStableCheckpoint.summary}" (score ${status.lastStableCheckpoint.scoreAtCheckpoint}).`
      : "No stable checkpoint yet.";
    const msg = `⚠ Possible drift in "${status.session.taskDescription}" — score ${status.currentScore ?? "—"}. ${summary}`;

    // The Revert action only appears when there's a checkpoint to revert to,
    // otherwise it would be a dead button.
    const actions = hasCheckpoint
      ? ["Revert to Last Stable", "Open in Dashboard", "Create Checkpoint", "Dismiss"]
      : ["Open in Dashboard", "Create Checkpoint", "Dismiss"];
    void vscode.window
      .showWarningMessage(msg, ...actions)
      .then((choice) => {
        if (choice === "Revert to Last Stable") {
          void vscode.commands.executeCommand("aidrift.revertToLastCheckpoint");
        } else if (choice === "Open in Dashboard") {
          void vscode.commands.executeCommand("aidrift.openActiveInDashboard");
        } else if (choice === "Create Checkpoint") {
          void vscode.commands.executeCommand("aidrift.createCheckpoint");
        }
      });
  }
}
