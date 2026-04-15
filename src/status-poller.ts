// Polls GET /sessions/:id/status for the active session and updates the
// VSCode status bar. Fires a one-shot notification when a drift alert
// first transitions to active.

import * as vscode from "vscode";
import type { ApiClient } from "./api-client";

interface StatusDto {
  session: { id: string; taskDescription: string };
  currentScore: number | null;
  trend: "improving" | "stable" | "drifting";
  turnCount: number;
  alert: { active: boolean; reasons: string[]; likelyDriftStartTurnId: string | null };
  lastStableCheckpoint: { summary: string; scoreAtCheckpoint: number } | null;
}

export class StatusPoller {
  private timer: NodeJS.Timeout | undefined;
  private lastAlertActive = false;
  private lastStatus: StatusDto | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly statusBar: vscode.StatusBarItem,
    private readonly getActiveSessionId: () => string | null,
    private readonly getActiveTaskDescription: () => string | null,
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

  private scheduleNext(): void {
    const intervalSec = vscode.workspace
      .getConfiguration("aidrift")
      .get<number>("statusPollIntervalSeconds", 3);
    this.timer = setTimeout(() => void this.tick(), Math.max(1, intervalSec) * 1000);
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
          this.statusBar.text = task ? "$(pulse) Drift —" : "$(pulse) Drift: watching";
          this.statusBar.command = "aidrift.openActiveInDashboard";
          this.statusBar.tooltip = "AI Drift — watching for Claude Code activity";
          this.statusBar.backgroundColor = undefined;
        }
        return;
      }

      const status = await this.api.request<StatusDto>(`/sessions/${sessionId}/status`);
      this.lastStatus = status;
      this.render(status);
      this.maybeNotify(status);
    } catch (err) {
      this.statusBar.text = "$(warning) Drift: api?";
      this.statusBar.tooltip = `AI Drift API unreachable: ${(err as Error).message}`;
      this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } finally {
      this.scheduleNext();
    }
  }

  private render(status: StatusDto): void {
    const score = status.currentScore;
    const trendArrow = status.trend === "improving" ? "↗" : status.trend === "drifting" ? "↘" : "→";
    if (score === null) {
      this.statusBar.text = `$(pulse) Drift — ${trendArrow}`;
    } else {
      const icon =
        score >= 80 ? "$(pulse)" :
        score >= 65 ? "$(alert)" :
        "$(flame)";
      this.statusBar.text = `${icon} Drift ${score} ${trendArrow}`;
    }
    this.statusBar.command = "aidrift.openActiveInDashboard";
    this.statusBar.tooltip = new vscode.MarkdownString(
      [
        `**${status.session.taskDescription}**`,
        ``,
        `Score: ${score ?? "—"} · Trend: ${status.trend} · Turns: ${status.turnCount}`,
        status.alert.active
          ? `\n\n⚠ **Drift alert**\n\n${status.alert.reasons.map((r) => `- ${r}`).join("\n")}`
          : "",
        status.lastStableCheckpoint
          ? `\n\nLast stable checkpoint: _${status.lastStableCheckpoint.summary}_ (score ${status.lastStableCheckpoint.scoreAtCheckpoint})`
          : "",
      ].join(""),
    );
    this.statusBar.backgroundColor = status.alert.active
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : undefined;
  }

  private maybeNotify(status: StatusDto): void {
    if (!status.alert.active) {
      this.lastAlertActive = false;
      return;
    }
    if (this.lastAlertActive) return; // already notified for this alert window
    this.lastAlertActive = true;

    const summary = status.lastStableCheckpoint
      ? `Last stable checkpoint: "${status.lastStableCheckpoint.summary}" (score ${status.lastStableCheckpoint.scoreAtCheckpoint}).`
      : "No stable checkpoint yet.";
    const msg = `⚠ Possible drift in "${status.session.taskDescription}" — score ${status.currentScore ?? "—"}. ${summary}`;
    void vscode.window
      .showWarningMessage(msg, "Open in Dashboard", "Create Checkpoint", "Dismiss")
      .then((choice) => {
        if (choice === "Open in Dashboard") {
          void vscode.commands.executeCommand("aidrift.openActiveInDashboard");
        } else if (choice === "Create Checkpoint") {
          void vscode.commands.executeCommand("aidrift.createCheckpoint");
        }
      });
  }
}
