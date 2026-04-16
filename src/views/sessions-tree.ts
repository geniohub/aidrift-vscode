// Sidebar tree view of recent drift sessions. Shows each session with a
// score badge and opens the dashboard detail page on click.

import * as vscode from "vscode";
import { normalize } from "node:path";
import type { ApiClient } from "../api-client";

interface SessionDto {
  id: string;
  taskDescription: string;
  provider: string;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
}

interface ScoreDto {
  score: number;
  trend: "improving" | "stable" | "drifting";
}

class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionDto,
    score: ScoreDto | null,
  ) {
    const scoreStr = score ? `${score.score} ${trendArrow(score.trend)}` : "— ·";
    super(`${scoreStr}  ${session.taskDescription}`, vscode.TreeItemCollapsibleState.None);
    this.id = session.id;
    this.description = `${session.provider}${session.model ? ` · ${session.model}` : ""}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${session.taskDescription}**`,
        ``,
        `provider: ${session.provider}`,
        session.model ? `model: ${session.model}` : "",
        score ? `score: ${score.score} (${score.trend})` : "no score yet",
        ``,
        `started: ${new Date(session.startedAt).toLocaleString()}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    if (score) {
      const iconId =
        score.score >= 80 ? "pulse" :
        score.score >= 65 ? "alert" :
        "flame";
      const iconColor =
        score.score >= 80 ? "charts.green" :
        score.score >= 65 ? "charts.yellow" :
        "charts.red";
      this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor(iconColor));
    } else {
      this.iconPath = new vscode.ThemeIcon("circle-outline");
    }
    this.command = {
      command: "aidrift.openSessionInDashboard",
      title: "Open in Dashboard",
      arguments: [session.id],
    };
  }
}

function trendArrow(trend: ScoreDto["trend"]): string {
  if (trend === "improving") return "↗";
  if (trend === "drifting") return "↘";
  return "→";
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private readonly _changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changeEmitter.event;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly api: ApiClient) {}

  startAutoRefresh(intervalMs = 5000): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => this.refresh(), intervalMs);
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  refresh(): void {
    this._changeEmitter.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<SessionTreeItem[]> {
    if (!(await this.api.isSignedIn())) {
      const signIn = new vscode.TreeItem("Sign in to AI Drift…", vscode.TreeItemCollapsibleState.None);
      signIn.command = { command: "aidrift.login", title: "Sign In" };
      signIn.iconPath = new vscode.ThemeIcon("account");
      return [signIn as unknown as SessionTreeItem];
    }
    try {
      const workspacePath = (vscode.workspace.workspaceFolders ?? [])
        .map((f) => normalize(f.uri.fsPath).replace(/[\\\/]+$/, ""))[0];
      const query = workspacePath ? `&workspacePath=${encodeURIComponent(workspacePath)}` : "";
      const sessions = await this.api.request<SessionDto[]>(`/sessions?limit=25${query}`);
      if (sessions.length === 0) {
        const empty = new vscode.TreeItem("No sessions yet. Chat in Claude Code to start.", vscode.TreeItemCollapsibleState.None);
        empty.iconPath = new vscode.ThemeIcon("info");
        return [empty as unknown as SessionTreeItem];
      }
      const scores = await Promise.all(
        sessions.map((s) =>
          this.api
            .request<ScoreDto | null>(`/sessions/${s.id}/score`)
            .catch(() => null),
        ),
      );
      return sessions.map((s, i) => new SessionTreeItem(s, scores[i] ?? null));
    } catch (err) {
      const error = new vscode.TreeItem(`API error: ${(err as Error).message}`, vscode.TreeItemCollapsibleState.None);
      error.iconPath = new vscode.ThemeIcon("error");
      return [error as unknown as SessionTreeItem];
    }
  }
}
