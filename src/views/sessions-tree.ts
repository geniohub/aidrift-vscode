import * as vscode from "vscode";
import { normalize } from "node:path";
import type { ApiClient } from "../api-client";

interface SessionDto {
  id: string;
  taskDescription: string;
  provider: string;
  model: string | null;
  workspacePath: string | null;
  startedAt: string;
  endedAt: string | null;
  currentScore?: number | null;
  trend?: "improving" | "stable" | "drifting" | null;
}

interface ScoreDto {
  score: number;
  trend: "improving" | "stable" | "drifting";
}

function normalizeWorkspacePath(p: string): string {
  return normalize(p).replace(/[\\\/]+$/, "");
}

function currentWorkspacePath(): string | undefined {
  return (vscode.workspace.workspaceFolders ?? [])
    .map((f) => normalizeWorkspacePath(f.uri.fsPath))[0];
}

function shortWorkspace(wp: string | null): string {
  if (!wp) return "?";
  const parts = wp.split("/");
  return parts.slice(-1)[0] ?? wp;
}

class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionDto,
    score: ScoreDto | null,
    currentWs: string | undefined,
  ) {
    const scoreStr = score ? `${score.score} ${trendArrow(score.trend)}` : "— ·";
    super(`${scoreStr}  ${session.taskDescription}`, vscode.TreeItemCollapsibleState.None);
    this.id = session.id;
    const wsLabel = shortWorkspace(session.workspacePath);
    const foreignWs = currentWs && session.workspacePath && session.workspacePath !== currentWs;
    this.description = [
      session.provider,
      session.model ? ` · ${session.model}` : "",
      foreignWs ? ` · [${wsLabel}]` : "",
    ].join("");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${session.taskDescription}**`,
        ``,
        `provider: ${session.provider}`,
        session.model ? `model: ${session.model}` : "",
        session.workspacePath ? `workspace: ${session.workspacePath}` : "workspace: (none)",
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
  private wsListener: vscode.Disposable | undefined;

  constructor(private readonly api: ApiClient) {}

  startAutoRefresh(intervalMs = 60_000): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => this.refresh(), intervalMs);
    this.wsListener = vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.wsListener?.dispose();
    this.wsListener = undefined;
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
      const workspacePath = currentWorkspacePath();
      const query = workspacePath
        ? `&workspacePath=${encodeURIComponent(workspacePath)}`
        : "";
      let sessions = await this.api.request<SessionDto[]>(`/sessions?limit=25${query}`);
      // Hard client-side filter: only show sessions matching this workspace.
      if (workspacePath) {
        sessions = sessions.filter((s) => s.workspacePath === workspacePath);
      }

      if (sessions.length === 0) {
        const empty = new vscode.TreeItem(
          workspacePath
            ? `No sessions for ${shortWorkspace(workspacePath)}. Chat in Claude Code to start.`
            : "No sessions yet. Chat in Claude Code to start.",
          vscode.TreeItemCollapsibleState.None,
        );
        empty.iconPath = new vscode.ThemeIcon("info");
        return [empty as unknown as SessionTreeItem];
      }
      return sessions.map((s) => {
        const score: ScoreDto | null =
          typeof s.currentScore === "number" && s.trend
            ? { score: s.currentScore, trend: s.trend }
            : null;
        return new SessionTreeItem(s, score, workspacePath);
      });
    } catch (err) {
      const error = new vscode.TreeItem(`API error: ${(err as Error).message}`, vscode.TreeItemCollapsibleState.None);
      error.iconPath = new vscode.ThemeIcon("error");
      return [error as unknown as SessionTreeItem];
    }
  }
}
