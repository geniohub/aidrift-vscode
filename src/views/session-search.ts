// Session search: QuickPick-based content search across the current user's
// sessions. Lives in the sidebar title bar (🔍 icon) and as a command palette
// entry ("Drift: Search Sessions"). Unlike the tree, which is workspace-
// scoped and paginated, this searches ALL of the user's sessions via the
// server /search endpoint — matches on session title, workspace, sessionHint,
// and turn content (userPrompt + modelResponse) with snippets.

import * as vscode from "vscode";
import { normalize } from "node:path";
import type { ApiClient } from "../api-client";

interface SessionHit {
  id: string;
  taskDescription: string;
  provider: string;
  model: string | null;
  workspacePath: string | null;
  startedAt: string;
}

interface TurnHit {
  sessionId: string;
  turnId: string;
  turnIndex: number;
  field: "userPrompt" | "modelResponse";
  snippet: string;
  createdAt: string;
}

interface SearchResponse {
  query: string;
  sessions: SessionHit[];
  turnHits: TurnHit[];
  truncated: boolean;
}

interface HitItem extends vscode.QuickPickItem {
  sessionId: string;
  turnIndex?: number;
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
  return wp.split("/").slice(-1)[0] ?? wp;
}

function fmtStarted(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export async function runSessionSearch(api: ApiClient): Promise<void> {
  if (!(await api.isSignedIn())) {
    await vscode.commands.executeCommand("aidrift.login");
    return;
  }

  const qp = vscode.window.createQuickPick<HitItem>();
  qp.placeholder = "Search sessions — title, workspace, prompts, responses…";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = false;

  // Scope toggle: start scoped to the current workspace when one exists, but
  // let the user flip to "all workspaces" via a QuickPick button.
  const currentWs = currentWorkspacePath();
  let scopeCurrent = Boolean(currentWs);
  const scopeButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("globe"),
    tooltip: "Search all workspaces (currently: this workspace)",
  };
  const scopeAllButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("folder-active"),
    tooltip: "Search this workspace only (currently: all workspaces)",
  };
  qp.buttons = currentWs ? [scopeButton] : [];

  let debounceTimer: NodeJS.Timeout | undefined;
  let lastRequestId = 0;

  const search = async (q: string): Promise<void> => {
    if (!q || q.trim().length < 2) {
      qp.items = [];
      qp.busy = false;
      return;
    }
    const myId = ++lastRequestId;
    qp.busy = true;
    try {
      const params = new URLSearchParams({ q: q.trim(), limit: "40" });
      if (scopeCurrent && currentWs) params.set("workspacePath", currentWs);
      const res = await api.request<SearchResponse>(`/search?${params.toString()}`);
      if (myId !== lastRequestId) return;
      const items: HitItem[] = [];
      if (res.sessions.length > 0) {
        items.push({
          label: `Sessions (${res.sessions.length})`,
          kind: vscode.QuickPickItemKind.Separator,
          sessionId: "",
        } as HitItem);
        const sessionIdsWithTurnHits = new Set(
          res.turnHits.map((t) => t.sessionId),
        );
        for (const s of res.sessions) {
          const badge =
            currentWs && s.workspacePath && s.workspacePath !== currentWs
              ? ` · [${shortWorkspace(s.workspacePath)}]`
              : "";
          const turnBadge = sessionIdsWithTurnHits.has(s.id) ? " · ↩ matches in content" : "";
          items.push({
            label: s.taskDescription,
            description: `${s.provider}${s.model ? " · " + s.model : ""}${badge}${turnBadge}`,
            detail: `started ${fmtStarted(s.startedAt)}`,
            sessionId: s.id,
          });
        }
      }
      if (res.turnHits.length > 0) {
        items.push({
          label: `Turn content (${res.turnHits.length})`,
          kind: vscode.QuickPickItemKind.Separator,
          sessionId: "",
        } as HitItem);
        const sessionById = new Map(res.sessions.map((s) => [s.id, s]));
        for (const t of res.turnHits) {
          const parent = sessionById.get(t.sessionId);
          const parentLabel = parent ? parent.taskDescription : "session " + t.sessionId.slice(-8);
          items.push({
            label: `turn ${t.turnIndex} · ${t.field === "userPrompt" ? "prompt" : "response"}`,
            description: parentLabel,
            detail: t.snippet,
            sessionId: t.sessionId,
            turnIndex: t.turnIndex,
          });
        }
      }
      if (items.length === 0) {
        items.push({
          label: "No matches.",
          description: "Try fewer or different words.",
          sessionId: "",
        });
      } else if (res.truncated) {
        items.push({
          label: "(results truncated — refine the query for more)",
          sessionId: "",
        });
      }
      qp.items = items;
    } catch (err) {
      if (myId !== lastRequestId) return;
      qp.items = [
        {
          label: "Search failed",
          description: (err as Error).message,
          sessionId: "",
        },
      ];
    } finally {
      if (myId === lastRequestId) qp.busy = false;
    }
  };

  qp.onDidChangeValue((value) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void search(value), 200);
  });

  qp.onDidTriggerButton(() => {
    scopeCurrent = !scopeCurrent;
    qp.buttons = scopeCurrent ? [scopeButton] : [scopeAllButton];
    if (qp.value) void search(qp.value);
  });

  qp.onDidAccept(() => {
    const pick = qp.selectedItems[0];
    if (pick && pick.sessionId) {
      void vscode.commands.executeCommand("aidrift.openSessionWebview", pick.sessionId);
    }
    qp.hide();
  });

  qp.onDidHide(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    qp.dispose();
  });

  qp.show();
}
