// Native VSCode webview for a session. Mirrors the dashboard's SessionDetailPage
// but fetches via the extension's authenticated ApiClient, and routes commit /
// file actions through native VSCode commands (diff, showTextDocument) instead
// of bouncing through vscode:// URIs.
//
// One panel per sessionId; re-opening focuses the existing panel. Polls status
// + turns + scores + git events every 5s while visible; pauses when hidden.

import * as vscode from "vscode";
import type { ApiClient } from "../api-client";
import { openDiffInVscode } from "../diff-handler";

const POLL_INTERVAL_MS = 5_000;

interface SessionDto {
  id: string;
  taskDescription: string;
  provider: string;
  model: string | null;
  workspacePath: string | null;
  gitRepoUrl: string | null;
  startedAt: string;
  endedAt: string | null;
}

interface StatusDto {
  session: SessionDto;
  currentScore: number | null;
  trend: "improving" | "stable" | "drifting";
  turnCount: number;
  alert: {
    active: boolean;
    reasons: string[];
    type: string;
    recommendation: string | null;
  };
}

interface TurnDto {
  id: string;
  turnIndex: number;
  userPrompt: string;
  modelResponse: string;
  createdAt: string;
  outcome: "pending" | "accepted" | "rejected";
}

interface ScoreDto {
  turnId: string;
  score: number;
  trend: "improving" | "stable" | "drifting";
  createdAt: string;
}

interface GitEventDto {
  id: string;
  turnId: string | null;
  type: "commit" | "push" | "branch_create" | "branch_switch";
  commitHash: string | null;
  commitShort: string | null;
  commitMessage: string | null;
  branch: string;
  author: string | null;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  createdAt: string;
}

interface PanelData {
  status: StatusDto | null;
  turns: TurnDto[];
  scores: ScoreDto[];
  commits: GitEventDto[];
  error: string | null;
}

export interface PanelDeps {
  api: ApiClient;
  workspaceRoots: () => string[];
  dashboardUrl: () => string;
  revealInSidebar: (sessionId: string) => Promise<void>;
}

const PANELS = new Map<string, SessionDetailPanel>();

export class SessionDetailPanel {
  static show(sessionId: string, deps: PanelDeps): SessionDetailPanel {
    const existing = PANELS.get(sessionId);
    if (existing) {
      existing.panel.reveal(undefined, false);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      "aidrift.sessionDetail",
      `Session ${sessionId.slice(-6)}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new SessionDetailPanel(sessionId, panel, deps);
    PANELS.set(sessionId, instance);
    return instance;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private data: PanelData = { status: null, turns: [], scores: [], commits: [], error: null };

  private constructor(
    private readonly sessionId: string,
    panel: vscode.WebviewPanel,
    private readonly deps: PanelDeps,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) this.startPolling();
        else this.stopPolling();
      },
      null,
      this.disposables,
    );
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );
    this.startPolling();
    void this.deps.revealInSidebar(this.sessionId);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async refresh(): Promise<void> {
    try {
      const [status, turns, scores, commits] = await Promise.all([
        this.deps.api.request<StatusDto>(`/sessions/${this.sessionId}/status`),
        this.deps.api.request<TurnDto[]>(`/sessions/${this.sessionId}/turns`),
        this.deps.api.request<ScoreDto[]>(`/sessions/${this.sessionId}/scores?limit=200`),
        this.deps.api
          .request<GitEventDto[]>(`/sessions/${this.sessionId}/git-events`)
          .catch(() => [] as GitEventDto[]),
      ]);
      this.data = { status, turns, scores, commits, error: null };
      if (status?.session?.taskDescription) {
        this.panel.title = shortTitle(status.session.taskDescription);
      }
    } catch (err) {
      this.data = { ...this.data, error: (err as Error).message };
    }
    this.post();
  }

  private post(): void {
    void this.panel.webview.postMessage({ type: "data", data: this.data });
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { command?: string; payload?: Record<string, unknown> };
    switch (m.command) {
      case "open-diff": {
        const fromSha = String(m.payload?.fromSha ?? "");
        const toSha = String(m.payload?.toSha ?? "");
        if (!fromSha || !toSha) return;
        await openDiffInVscode({
          fromSha,
          toSha,
          workspaceRoots: this.deps.workspaceRoots(),
        });
        return;
      }
      case "open-file": {
        const file = String(m.payload?.filePath ?? "");
        if (!file) return;
        await this.openFile(file);
        return;
      }
      case "resume-last-file": {
        await this.resumeLastFile();
        return;
      }
      case "reveal-in-sidebar": {
        await this.deps.revealInSidebar(this.sessionId);
        return;
      }
      case "open-in-dashboard": {
        const url = `${this.deps.dashboardUrl()}/sessions/${this.sessionId}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      case "refresh": {
        await this.refresh();
        return;
      }
    }
  }

  private async openFile(filePath: string): Promise<void> {
    const roots = this.deps.workspaceRoots();
    // If the filePath is absolute and exists in a workspace root, use it;
    // otherwise treat as relative to the first root.
    const target = filePath.startsWith("/")
      ? vscode.Uri.file(filePath)
      : roots[0]
        ? vscode.Uri.joinPath(vscode.Uri.file(roots[0]), filePath)
        : undefined;
    if (!target) {
      void vscode.window.showWarningMessage("AI Drift: no workspace folder to resolve file against.");
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
    } catch (err) {
      void vscode.window.showWarningMessage(`AI Drift: couldn't open ${filePath}: ${(err as Error).message}`);
    }
  }

  private async resumeLastFile(): Promise<void> {
    const lastCommit = this.data.commits.find((c) => c.type === "commit" && c.commitHash);
    if (!lastCommit?.commitHash) {
      void vscode.window.showInformationMessage(
        "AI Drift: no commits recorded for this session yet — can't resume.",
      );
      return;
    }
    // Best-effort: diff the last commit against its parent and open the first
    // changed file in a side editor. Uses the existing diff handler to reuse
    // its Git extension plumbing and error UX.
    await openDiffInVscode({
      fromSha: `${lastCommit.commitHash}^`,
      toSha: lastCommit.commitHash,
      workspaceRoots: this.deps.workspaceRoots(),
    });
  }

  dispose(): void {
    PANELS.delete(this.sessionId);
    this.stopPolling();
    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* noop */ }
    }
    try { this.panel.dispose(); } catch { /* noop */ }
  }

  private renderHtml(): string {
    const nonce = randomNonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { color-scheme: var(--vscode-colorScheme, light dark); }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 16px 20px 48px;
    line-height: 1.5;
  }
  h1 { font-size: 1.1em; margin: 0 0 4px; font-weight: 600; }
  h2 { font-size: 0.95em; margin: 24px 0 8px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.06em; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .header { display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; }
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 1px 8px; border-radius: 10px;
    font-size: 0.8em;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .score-badge { font-weight: 600; }
  .score-ok { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 25%, transparent); color: var(--vscode-foreground); }
  .score-warn { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #f0b429) 30%, transparent); color: var(--vscode-foreground); }
  .score-bad { background: color-mix(in srgb, var(--vscode-editorError-foreground, #f85149) 30%, transparent); color: var(--vscode-foreground); }
  .alert { margin-top: 10px; padding: 8px 10px; border-radius: 4px; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); color: var(--vscode-inputValidation-warningForeground); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  button {
    cursor: pointer;
    font: inherit;
    padding: 4px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .turn {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 10px 0;
    display: flex; gap: 10px; align-items: flex-start;
  }
  .turn-idx { min-width: 32px; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); font-size: 0.85em; padding-top: 2px; }
  .turn-body { flex: 1; min-width: 0; }
  .turn-prompt { white-space: pre-wrap; word-break: break-word; margin-bottom: 4px; font-size: 0.95em; }
  .turn-meta { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  .commit {
    display: flex; gap: 8px; padding: 6px 0; align-items: center;
    border-top: 1px solid var(--vscode-panel-border);
    font-size: 0.9em;
  }
  .commit:first-child { border-top: none; }
  .commit-sha { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); cursor: pointer; }
  .commit-sha:hover { text-decoration: underline; }
  .commit-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit-stat { color: var(--vscode-descriptionForeground); font-size: 0.85em; font-variant-numeric: tabular-nums; }
  .spinner { color: var(--vscode-descriptionForeground); font-style: italic; padding: 12px 0; }
  .error { color: var(--vscode-errorForeground); padding: 8px 10px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 3px; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 8px 0; }
</style>
</head>
<body>
  <div id="root"><div class="spinner">Loading session…</div></div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const root = document.getElementById('root');

      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
      const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
      const shortSha = (sha) => (sha ? String(sha).slice(0, 7) : '');
      const trendArrow = (t) => t === 'improving' ? '↗' : t === 'drifting' ? '↘' : '→';
      const scoreClass = (s) => s == null ? '' : s >= 80 ? 'score-ok' : s >= 65 ? 'score-warn' : 'score-bad';

      const send = (command, payload) => vscode.postMessage({ command, payload });

      function renderHeader(data) {
        const s = data.status?.session;
        if (!s) return '';
        const score = data.status?.currentScore;
        const trend = data.status?.trend ?? 'stable';
        const alert = data.status?.alert;
        const turnCount = data.status?.turnCount ?? 0;
        const scoreHtml = score == null
          ? '<span class="badge">no score yet</span>'
          : '<span class="badge score-badge ' + scoreClass(score) + '">' + score + ' ' + trendArrow(trend) + '</span>';
        const provHtml = '<span class="badge">' + esc(s.provider) + (s.model ? ' · ' + esc(s.model) : '') + '</span>';
        const wsHtml = s.workspacePath ? '<span class="muted">' + esc(s.workspacePath) + '</span>' : '';
        const alertHtml = alert?.active
          ? '<div class="alert"><strong>Drift alert:</strong> ' + esc(alert.reasons?.[0] ?? 'drift detected') + (alert.recommendation ? ' <em>— ' + esc(alert.recommendation) + '</em>' : '') + '</div>'
          : '';
        return (
          '<div class="header">' +
          '<h1>' + esc(s.taskDescription || '(untitled)') + '</h1>' +
          '<div class="row">' + scoreHtml + provHtml + '<span class="muted">' + turnCount + ' turn' + (turnCount === 1 ? '' : 's') + '</span>' + wsHtml + '</div>' +
          alertHtml +
          '<div class="actions">' +
          '<button class="primary" id="btn-resume">Resume at last change</button>' +
          '<button id="btn-reveal">Reveal in sidebar</button>' +
          '<button id="btn-dashboard">Open in dashboard</button>' +
          '<button id="btn-refresh">Refresh</button>' +
          '</div>' +
          '</div>'
        );
      }

      function renderCommits(commits) {
        const commitEvents = (commits ?? []).filter((e) => e.type === 'commit' && e.commitHash);
        if (commitEvents.length === 0) {
          return '<h2>Commits</h2><div class="empty">No commits yet for this session.</div>';
        }
        const items = commitEvents.map((c, idx) => {
          const next = commitEvents[idx - 1]; // newer commit (we'll reverse order below)
          const fromSha = next?.commitHash ?? (c.commitHash + '^');
          const toSha = c.commitHash;
          const stat = (c.filesChanged != null)
            ? '<span class="commit-stat">' + c.filesChanged + ' file' + (c.filesChanged === 1 ? '' : 's') + (c.insertions != null ? ' · +' + c.insertions : '') + (c.deletions != null ? ' · −' + c.deletions : '') + '</span>'
            : '';
          return (
            '<div class="commit">' +
            '<span class="commit-sha" data-from="' + esc(fromSha) + '" data-to="' + esc(toSha) + '" title="Open diff in VSCode">' + esc(shortSha(c.commitHash)) + '</span>' +
            '<span class="commit-msg" title="' + esc(c.commitMessage ?? '') + '">' + esc(c.commitMessage ?? '(no message)') + '</span>' +
            stat +
            '<span class="commit-stat">' + esc(fmtTime(c.createdAt)) + '</span>' +
            '</div>'
          );
        }).join('');
        return '<h2>Commits</h2>' + items;
      }

      function renderTurns(data) {
        const turns = (data.turns ?? []).slice().sort((a, b) => b.turnIndex - a.turnIndex);
        if (turns.length === 0) {
          return '<h2>Turns</h2><div class="empty">No turns recorded yet.</div>';
        }
        const scoreById = new Map((data.scores ?? []).map((s) => [s.turnId, s]));
        const items = turns.map((t) => {
          const sc = scoreById.get(t.id);
          const scBadge = sc
            ? '<span class="badge ' + scoreClass(sc.score) + '">' + sc.score + ' ' + trendArrow(sc.trend) + '</span>'
            : '';
          const outcome = t.outcome && t.outcome !== 'pending' ? '<span class="badge">' + esc(t.outcome) + '</span>' : '';
          const prompt = (t.userPrompt || '').trim();
          const preview = prompt.length > 400 ? prompt.slice(0, 400) + '…' : prompt;
          return (
            '<div class="turn">' +
            '<div class="turn-idx">#' + t.turnIndex + '</div>' +
            '<div class="turn-body">' +
            '<div class="turn-prompt">' + esc(preview || '(no prompt)') + '</div>' +
            '<div class="turn-meta row">' + scBadge + outcome + '<span>' + esc(fmtTime(t.createdAt)) + '</span></div>' +
            '</div>' +
            '</div>'
          );
        }).join('');
        return '<h2>Turns</h2>' + items;
      }

      function render(data) {
        if (data.error && !data.status) {
          root.innerHTML = '<div class="error">Error loading session: ' + esc(data.error) + '</div>';
          return;
        }
        if (!data.status) {
          root.innerHTML = '<div class="spinner">Loading session…</div>';
          return;
        }
        root.innerHTML =
          renderHeader(data) +
          (data.error ? '<div class="error" style="margin-top:10px">Refresh failed: ' + esc(data.error) + '</div>' : '') +
          renderCommits(data.commits) +
          renderTurns(data);

        document.getElementById('btn-resume')?.addEventListener('click', () => send('resume-last-file'));
        document.getElementById('btn-reveal')?.addEventListener('click', () => send('reveal-in-sidebar'));
        document.getElementById('btn-dashboard')?.addEventListener('click', () => send('open-in-dashboard'));
        document.getElementById('btn-refresh')?.addEventListener('click', () => send('refresh'));
        document.querySelectorAll('.commit-sha').forEach((el) => {
          el.addEventListener('click', () => {
            const fromSha = el.getAttribute('data-from');
            const toSha = el.getAttribute('data-to');
            send('open-diff', { fromSha, toSha });
          });
        });
      }

      window.addEventListener('message', (ev) => {
        const msg = ev.data;
        if (msg?.type === 'data') render(msg.data);
      });
    })();
  </script>
</body>
</html>`;
  }
}

function shortTitle(task: string): string {
  const trimmed = task.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed || "Session";
}

function randomNonce(): string {
  let out = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
