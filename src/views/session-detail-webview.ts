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
import {
  evaluateLocalPredicates,
  getCurrentHeadSha,
  resetHard,
  revertRange,
  stashWorkingTree,
  type LocalPredicates,
} from "../revert-predicates";

const POLL_INTERVAL_MS = 5_000;

// Six-axis "fits" predicate set (Phase 5 / Phase 6 of Git Provenance).
// `value === true` is the only state that counts as a pass — null is
// "couldn't determine", and the all-green gate requires explicit true.
type PredicateState = {
  value: boolean | null;
  source: "server" | "client";
  note: string;
};

interface MergedPredicates {
  workingTreeClean: PredicateState;
  targetExists: PredicateState;
  noUnpushedBetween: PredicateState;
  noPushedBetween: PredicateState;
  leaksAtTarget: PredicateState;
  scopeImproves: PredicateState;
}

interface RevertDialogState {
  sha: string;
  shortSha: string;
  subject: string | null;
  branch: string;
  fromSha: string | null; // current HEAD when dialog opened
  predicates: MergedPredicates;
  fits: boolean;
  // "reset" means `git reset --hard <sha>` is appropriate (no pushed
  // commits in target..HEAD); "revert" means `git revert <sha>..HEAD`
  // because pushed history would otherwise diverge.
  suggestedMethod: "reset" | "revert";
  suggestedCommand: string;
  workingTreeWasDirty: boolean;
  loading: boolean;
  errors: string[];
  // Set while the actual git op is running so the UI can disable the
  // button without the user being able to double-click.
  executing: boolean;
}

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
  revertDialog: RevertDialogState | null;
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
  private lastFetchedTurnCount: number | null = null;
  private data: PanelData = {
    status: null,
    turns: [],
    scores: [],
    commits: [],
    error: null,
    revertDialog: null,
  };

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

  private async refresh(forceTurns = false): Promise<void> {
    try {
      const [status, scores, commits] = await Promise.all([
        this.deps.api.request<StatusDto>(`/sessions/${this.sessionId}/status`),
        this.deps.api.request<ScoreDto[]>(`/sessions/${this.sessionId}/scores?limit=200`),
        this.deps.api
          .request<GitEventDto[]>(`/sessions/${this.sessionId}/git-events`)
          .catch(() => [] as GitEventDto[]),
      ]);

      const shouldRefreshTurns =
        forceTurns ||
        this.lastFetchedTurnCount === null ||
        status.turnCount !== this.lastFetchedTurnCount;
      const turns = shouldRefreshTurns
        ? await this.deps.api.request<TurnDto[]>(`/sessions/${this.sessionId}/turns?limit=200`)
        : this.data.turns;
      if (shouldRefreshTurns) this.lastFetchedTurnCount = status.turnCount;

      // Preserve any open revert dialog across polls so a slow git op
      // doesn't get its UI yanked out from under the user.
      this.data = {
        status,
        turns,
        scores,
        commits,
        error: null,
        revertDialog: this.data.revertDialog,
      };
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
        await this.refresh(true);
        return;
      }
      case "open-revert": {
        const sha = String(m.payload?.sha ?? "");
        if (!sha) return;
        await this.openRevertDialog(sha);
        return;
      }
      case "close-revert": {
        if (this.data.revertDialog?.executing) return;
        this.data = { ...this.data, revertDialog: null };
        this.post();
        return;
      }
      case "copy-revert-command": {
        const cmd = String(m.payload?.command ?? "");
        if (!cmd) return;
        await vscode.env.clipboard.writeText(cmd);
        void vscode.window.showInformationMessage(
          `AI Drift: copied — ${cmd}`,
        );
        return;
      }
      case "execute-revert": {
        await this.executeRevert();
        return;
      }
    }
  }

  // Resolves the cwd for git ops. Prefers session.workspacePath when it
  // matches an open workspace folder; falls back to the first folder.
  private resolveGitCwd(): string | null {
    const roots = this.deps.workspaceRoots();
    const sessionPath = this.data.status?.session?.workspacePath;
    if (sessionPath && roots.includes(sessionPath)) return sessionPath;
    return roots[0] ?? null;
  }

  private async openRevertDialog(sha: string): Promise<void> {
    const cwd = this.resolveGitCwd();
    if (!cwd) {
      void vscode.window.showWarningMessage(
        "AI Drift: no workspace folder open — can't run git locally for the revert preview.",
      );
      return;
    }

    // Show the dialog in a loading state immediately so the user gets
    // feedback while the API + git calls run.
    this.data = {
      ...this.data,
      revertDialog: {
        sha,
        shortSha: sha.slice(0, 7),
        subject: null,
        branch: "",
        fromSha: null,
        predicates: emptyPredicates(),
        fits: false,
        suggestedMethod: "reset",
        suggestedCommand: `git reset --hard ${sha}`,
        workingTreeWasDirty: false,
        loading: true,
        errors: [],
        executing: false,
      },
    };
    this.post();

    let serverPreview: ServerPreview | null = null;
    let preview: LocalPredicates;
    let headSha: string | null;
    const errors: string[] = [];
    try {
      [serverPreview, preview, headSha] = await Promise.all([
        this.deps.api
          .request<ServerPreview>(`/commits/${sha}/revert-preview`)
          .catch((e: Error) => {
            errors.push(`server preview: ${e.message}`);
            return null;
          }),
        evaluateLocalPredicates(cwd, sha),
        getCurrentHeadSha(cwd),
      ]);
    } catch (err) {
      errors.push(`unexpected: ${(err as Error).message}`);
      preview = {
        workingTreeClean: null,
        targetExists: null,
        noUnpushedBetween: null,
        noPushedBetween: null,
        hasUpstream: false,
        errors: [],
      };
      headSha = null;
    }
    errors.push(...preview.errors);

    const merged = mergePredicates(serverPreview, preview);
    const fits = predicateValues(merged).every((p) => p.value === true);
    const suggestedMethod: "reset" | "revert" =
      merged.noPushedBetween.value === false ? "revert" : "reset";
    const suggestedCommand =
      suggestedMethod === "reset"
        ? `git reset --hard ${sha}`
        : `git revert --no-edit ${sha}..HEAD`;

    this.data = {
      ...this.data,
      revertDialog: {
        sha,
        shortSha: serverPreview?.target.shortSha ?? sha.slice(0, 7),
        subject: serverPreview?.target.subject ?? null,
        branch: serverPreview?.target.branch ?? "",
        fromSha: headSha,
        predicates: merged,
        fits,
        suggestedMethod,
        suggestedCommand,
        workingTreeWasDirty: preview.workingTreeClean === false,
        loading: false,
        errors,
        executing: false,
      },
    };
    this.post();
  }

  private async executeRevert(): Promise<void> {
    const dlg = this.data.revertDialog;
    if (!dlg || !dlg.fits || dlg.executing) return;
    if (!dlg.fromSha) {
      void vscode.window.showErrorMessage(
        "AI Drift: couldn't read current HEAD — refusing to revert.",
      );
      return;
    }
    const cwd = this.resolveGitCwd();
    if (!cwd) {
      void vscode.window.showErrorMessage(
        "AI Drift: no workspace folder — can't execute git locally.",
      );
      return;
    }

    const confirmLabel =
      dlg.suggestedMethod === "reset" ? "Reset" : "Revert";
    const confirmDetail =
      dlg.suggestedMethod === "reset"
        ? `Will run: git reset --hard ${dlg.shortSha} (discards commits after the target).`
        : `Will run: git revert --no-edit ${dlg.shortSha}..HEAD (creates revert commits, history preserved).`;
    const choice = await vscode.window.showWarningMessage(
      `Revert workspace to ${dlg.shortSha}?`,
      { modal: true, detail: confirmDetail },
      confirmLabel,
    );
    if (choice !== confirmLabel) return;

    this.data = {
      ...this.data,
      revertDialog: { ...dlg, executing: true },
    };
    this.post();

    let methodExecuted: "reset" | "revert" | "stash+reset" | "stash+revert" =
      dlg.suggestedMethod;
    try {
      if (dlg.workingTreeWasDirty) {
        const stashLabel = `aidrift pre-revert ${dlg.shortSha} ${new Date().toISOString()}`;
        await stashWorkingTree(cwd, stashLabel);
        methodExecuted = dlg.suggestedMethod === "reset" ? "stash+reset" : "stash+revert";
      }
      if (dlg.suggestedMethod === "reset") {
        await resetHard(cwd, dlg.sha);
      } else {
        await revertRange(cwd, dlg.sha);
      }
    } catch (err) {
      this.data = {
        ...this.data,
        revertDialog: { ...dlg, executing: false, errors: [...dlg.errors, `revert failed: ${(err as Error).message}`] },
      };
      this.post();
      void vscode.window.showErrorMessage(
        `AI Drift: revert failed — ${(err as Error).message}`,
      );
      return;
    }

    // Best-effort POST. Failure here doesn't block the user — the git op
    // already succeeded; we just lose one DAG row.
    try {
      await this.deps.api.request("/commits/" + dlg.sha + "/revert-event", {
        method: "POST",
        body: JSON.stringify({
          sessionId: this.sessionId,
          fromSha: dlg.fromSha,
          toSha: dlg.sha,
          method: methodExecuted,
          workingTreeWasDirty: dlg.workingTreeWasDirty,
          predicateSnapshot: snapshotFromPredicates(dlg.predicates),
        }),
      });
    } catch (err) {
      void vscode.window.showWarningMessage(
        `AI Drift: revert ran, but couldn't record the event — ${(err as Error).message}`,
      );
    }

    void vscode.window.showInformationMessage(
      methodExecuted.startsWith("stash+")
        ? `AI Drift: stashed working tree, then ${dlg.suggestedMethod === "reset" ? "reset --hard" : "reverted"} to ${dlg.shortSha}.`
        : `AI Drift: ${dlg.suggestedMethod === "reset" ? "reset --hard" : "reverted"} to ${dlg.shortSha}.`,
    );

    this.data = { ...this.data, revertDialog: null };
    this.post();
    await this.refresh(true);
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
  .commit-actions { display: flex; gap: 4px; }
  .commit button.btn-revert { padding: 1px 8px; font-size: 0.85em; }
  .spinner { color: var(--vscode-descriptionForeground); font-style: italic; padding: 12px 0; }
  .error { color: var(--vscode-errorForeground); padding: 8px 10px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 3px; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 8px 0; }
  /* Revert dialog — modal-style overlay rendered in the webview itself
     so we don't need a second panel just to host the safety radar. */
  .revert-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
  }
  .revert-modal {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 16px 18px;
    width: min(560px, 92vw);
    max-height: 90vh; overflow: auto;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
  }
  .revert-modal h3 { margin: 0 0 4px; font-size: 1em; font-weight: 600; }
  .revert-modal .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 12px; }
  .revert-modal .radar-row { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 12px; }
  .revert-modal .radar { flex: 0 0 200px; }
  .revert-modal .pred-list { flex: 1; min-width: 0; font-size: 0.85em; }
  .revert-modal .pred-list .pred {
    display: flex; gap: 6px; align-items: flex-start; padding: 3px 0;
  }
  .revert-modal .pred-dot {
    flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%;
    margin-top: 6px;
  }
  .pred-dot.pass { background: var(--vscode-testing-iconPassed, #3fb950); }
  .pred-dot.fail { background: var(--vscode-editorError-foreground, #f85149); }
  .pred-dot.unknown { background: var(--vscode-descriptionForeground); opacity: 0.5; }
  .revert-modal .pred-name { font-weight: 600; min-width: 130px; }
  .revert-modal .pred-note { color: var(--vscode-descriptionForeground); flex: 1; }
  .revert-modal .verdict {
    margin: 8px 0 12px; padding: 6px 10px; border-radius: 3px;
    font-size: 0.9em;
  }
  .revert-modal .verdict.fits {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 18%, transparent);
  }
  .revert-modal .verdict.unsafe {
    background: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    color: var(--vscode-inputValidation-warningForeground);
  }
  .revert-modal .cmd-row {
    display: flex; gap: 6px; align-items: center;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 4px 8px; margin-bottom: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
  }
  .revert-modal .cmd-row code { flex: 1; overflow-x: auto; white-space: nowrap; }
  .revert-modal .errors {
    margin: 0 0 10px; padding: 6px 10px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    border-radius: 3px; font-size: 0.85em;
    color: var(--vscode-errorForeground);
  }
  .revert-modal .actions { display: flex; gap: 6px; justify-content: flex-end; }
  .revert-modal .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
  .revert-modal .loading { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
  .radar svg { display: block; }
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
            '<span class="commit-actions"><button class="btn-revert" data-revert-sha="' + esc(toSha) + '" title="Preview revert to this commit">Revert</button></span>' +
            '</div>'
          );
        }).join('');
        return '<h2>Commits</h2>' + items;
      }

      // Six-axis safety radar. Predicates feed in fixed order so the
      // hexagon vertices map 1:1 to predicate names. Green = pass,
      // grey/dim = unknown, red = fail. The polygon rendered inside
      // the hexagon is the convex hull of the predicate states scaled
      // to its axis (pass = full radius, fail/unknown = half).
      function predicateRow(p) {
        return [
          { key: 'workingTreeClean',   label: 'Working tree clean',  state: p.workingTreeClean },
          { key: 'targetExists',       label: 'Target exists',       state: p.targetExists },
          { key: 'noUnpushedBetween',  label: 'No unpushed between', state: p.noUnpushedBetween },
          { key: 'noPushedBetween',    label: 'No pushed between',   state: p.noPushedBetween },
          { key: 'leaksAtTarget',      label: 'No leaks at target',  state: p.leaksAtTarget },
          { key: 'scopeImproves',      label: 'Scope improves',      state: p.scopeImproves },
        ];
      }

      function dotClass(value) {
        if (value === true) return 'pass';
        if (value === false) return 'fail';
        return 'unknown';
      }

      function renderRadar(p) {
        const cx = 100, cy = 100, r = 80;
        const rows = predicateRow(p);
        // Hexagon vertices, starting at top, clockwise.
        const points = rows.map((row, i) => {
          const angle = -Math.PI / 2 + (i * Math.PI * 2) / 6;
          const scale = row.state.value === true ? 1 : row.state.value === false ? 0.35 : 0.55;
          const x = cx + Math.cos(angle) * r * scale;
          const y = cy + Math.sin(angle) * r * scale;
          const lx = cx + Math.cos(angle) * (r + 14);
          const ly = cy + Math.sin(angle) * (r + 14);
          const fill = row.state.value === true
            ? 'var(--vscode-testing-iconPassed, #3fb950)'
            : row.state.value === false
              ? 'var(--vscode-editorError-foreground, #f85149)'
              : 'var(--vscode-descriptionForeground)';
          return { x, y, lx, ly, fill, label: row.label, state: row.state };
        });

        // Background hex grid (3 concentric rings).
        const ring = (k) => points.map((_, i) => {
          const angle = -Math.PI / 2 + (i * Math.PI * 2) / 6;
          return (cx + Math.cos(angle) * r * k) + ',' + (cy + Math.sin(angle) * r * k);
        }).join(' ');

        const polygon = points.map((p) => p.x + ',' + p.y).join(' ');

        const labels = points.map((p) => {
          const anchor = p.lx < cx - 1 ? 'end' : p.lx > cx + 1 ? 'start' : 'middle';
          // Tiny axis labels so the hex stays readable at 200px wide.
          return '<text x="' + p.lx + '" y="' + p.ly + '" text-anchor="' + anchor + '" dominant-baseline="middle" font-size="9" fill="var(--vscode-descriptionForeground)">' + esc(p.label) + '</text>';
        }).join('');

        const dots = points.map((p) => {
          return '<circle cx="' + p.x + '" cy="' + p.y + '" r="4" fill="' + p.fill + '" />';
        }).join('');

        return (
          '<svg viewBox="0 0 200 200" width="200" height="200">' +
          '<polygon points="' + ring(1) + '" fill="none" stroke="var(--vscode-panel-border)" />' +
          '<polygon points="' + ring(0.66) + '" fill="none" stroke="var(--vscode-panel-border)" opacity="0.6" />' +
          '<polygon points="' + ring(0.33) + '" fill="none" stroke="var(--vscode-panel-border)" opacity="0.4" />' +
          '<polygon points="' + polygon + '" fill="color-mix(in srgb, var(--vscode-foreground) 18%, transparent)" stroke="var(--vscode-foreground)" stroke-opacity="0.6" stroke-width="1.2" />' +
          dots +
          labels +
          '</svg>'
        );
      }

      function renderRevertDialog(dlg) {
        if (!dlg) return '';
        if (dlg.loading) {
          return (
            '<div class="revert-backdrop" id="revert-backdrop">' +
            '<div class="revert-modal">' +
            '<h3>Revert preview — ' + esc(dlg.shortSha) + '</h3>' +
            '<div class="loading">Evaluating safety…</div>' +
            '<div class="actions"><button id="btn-cancel-revert">Cancel</button></div>' +
            '</div></div>'
          );
        }
        const rows = predicateRow(dlg.predicates);
        const predList = rows.map((r) =>
          '<div class="pred">' +
          '<div class="pred-dot ' + dotClass(r.state.value) + '"></div>' +
          '<div class="pred-name">' + esc(r.label) + '</div>' +
          '<div class="pred-note">' + esc(r.state.note || '') + '</div>' +
          '</div>'
        ).join('');

        const verdict = dlg.fits
          ? '<div class="verdict fits">All six predicates pass — safe to revert.</div>'
          : '<div class="verdict unsafe">One or more predicates failed — Revert is disabled. Use "Copy command" if you want to run it manually.</div>';

        const errs = (dlg.errors && dlg.errors.length > 0)
          ? '<div class="errors"><strong>Notes:</strong> ' + esc(dlg.errors.join('; ')) + '</div>'
          : '';

        const subjectLine = dlg.subject
          ? '<div class="subtitle">' + esc(dlg.subject) + (dlg.branch ? ' · <em>' + esc(dlg.branch) + '</em>' : '') + '</div>'
          : (dlg.branch ? '<div class="subtitle"><em>' + esc(dlg.branch) + '</em></div>' : '');

        return (
          '<div class="revert-backdrop" id="revert-backdrop">' +
          '<div class="revert-modal">' +
          '<h3>Revert to ' + esc(dlg.shortSha) + '</h3>' +
          subjectLine +
          '<div class="radar-row">' +
          '<div class="radar">' + renderRadar(dlg.predicates) + '</div>' +
          '<div class="pred-list">' + predList + '</div>' +
          '</div>' +
          verdict +
          '<div class="cmd-row"><code>' + esc(dlg.suggestedCommand) + '</code><button id="btn-copy-revert">Copy</button></div>' +
          errs +
          '<div class="actions">' +
          '<button id="btn-cancel-revert"' + (dlg.executing ? ' disabled' : '') + '>Cancel</button>' +
          '<button class="primary" id="btn-execute-revert"' + (dlg.fits && !dlg.executing ? '' : ' disabled') + '>' +
          (dlg.executing ? 'Running…' : (dlg.suggestedMethod === 'reset' ? 'Reset --hard' : 'Revert range')) +
          '</button>' +
          '</div>' +
          '</div></div>'
        );
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
          renderTurns(data) +
          renderRevertDialog(data.revertDialog);

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
        document.querySelectorAll('button.btn-revert').forEach((el) => {
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const sha = el.getAttribute('data-revert-sha');
            if (sha) send('open-revert', { sha });
          });
        });

        // Revert-dialog wiring (only present when data.revertDialog is set).
        const dlg = data.revertDialog;
        if (dlg) {
          document.getElementById('btn-cancel-revert')?.addEventListener('click', () => send('close-revert'));
          document.getElementById('btn-copy-revert')?.addEventListener('click', () => send('copy-revert-command', { command: dlg.suggestedCommand }));
          document.getElementById('btn-execute-revert')?.addEventListener('click', () => send('execute-revert'));
          document.getElementById('revert-backdrop')?.addEventListener('click', (ev) => {
            // Click outside the modal closes it (but never while executing).
            if (ev.target === ev.currentTarget && !dlg.executing) send('close-revert');
          });
        }
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

// Subset of the server's RevertPreviewDto we actually consume here. Kept
// loose on purpose — the extension intentionally doesn't depend on
// @aidrift/core. Renaming a server field becomes a runtime miss instead
// of a build break, but the panel degrades cleanly via the `errors[]`.
interface ServerPreview {
  target: {
    sha: string;
    shortSha: string;
    subject: string | null;
    branch: string;
    createdAt: string;
  };
  predicates: {
    workingTreeClean: PredicateState;
    targetExists: PredicateState;
    noUnpushedBetween: PredicateState;
    noPushedBetween: PredicateState;
    leaksAtTarget: PredicateState;
    scopeImproves: PredicateState;
  };
  fits: boolean;
  suggestedCommand: string;
}

function emptyPredicates(): MergedPredicates {
  const empty: PredicateState = {
    value: null,
    source: "client",
    note: "loading…",
  };
  return {
    workingTreeClean: empty,
    targetExists: empty,
    noUnpushedBetween: empty,
    noPushedBetween: empty,
    leaksAtTarget: empty,
    scopeImproves: empty,
  };
}

// Merge server-evaluated predicates (5, 6, server-half of 2) with the
// extension's local checks (1, 3, 4, client-half of 2). Local wins for
// any predicate the workspace can answer authoritatively.
function mergePredicates(
  server: ServerPreview | null,
  local: LocalPredicates,
): MergedPredicates {
  const fallback: PredicateState = {
    value: null,
    source: "server",
    note: "server preview unavailable",
  };
  const s = server?.predicates;
  // Predicate 2: target must exist on the server's GitEvent ledger AND
  // in the user's actual repo. Combine both as AND with `null` propagating.
  const targetExists: PredicateState = (() => {
    const serverTrue = s?.targetExists.value === true;
    const localVal = local.targetExists;
    if (serverTrue && localVal === true) {
      return { value: true, source: "client", note: "target sha present locally and on server" };
    }
    if (localVal === false) {
      return { value: false, source: "client", note: "target sha not found in local repo (may need fetch)" };
    }
    if (s && s.targetExists.value === false) {
      return { value: false, source: "server", note: s.targetExists.note };
    }
    return { value: null, source: "client", note: "target existence unverified" };
  })();

  return {
    workingTreeClean: {
      value: local.workingTreeClean,
      source: "client",
      note:
        local.workingTreeClean === true
          ? "working tree clean"
          : local.workingTreeClean === false
            ? "uncommitted changes — will stash before revert"
            : "couldn't read git status",
    },
    targetExists,
    noUnpushedBetween: {
      value: local.noUnpushedBetween,
      source: "client",
      note:
        local.noUnpushedBetween === true
          ? "no unpushed commits between HEAD and target"
          : local.noUnpushedBetween === false
            ? "unpushed work between HEAD and target — would be lost by reset"
            : "couldn't evaluate gap (no upstream?)",
    },
    noPushedBetween: {
      value: local.noPushedBetween,
      source: "client",
      note:
        local.noPushedBetween === true
          ? local.hasUpstream
            ? "no pushed commits between HEAD and target"
            : "branch has no upstream — nothing pushed"
          : local.noPushedBetween === false
            ? "pushed commits between HEAD and target — will use git revert (history preserved)"
            : "couldn't evaluate pushed range",
    },
    leaksAtTarget: s?.leaksAtTarget ?? fallback,
    scopeImproves: s?.scopeImproves ?? fallback,
  };
}

function predicateValues(p: MergedPredicates): PredicateState[] {
  return [
    p.workingTreeClean,
    p.targetExists,
    p.noUnpushedBetween,
    p.noPushedBetween,
    p.leaksAtTarget,
    p.scopeImproves,
  ];
}

function snapshotFromPredicates(p: MergedPredicates) {
  return {
    workingTreeClean: p.workingTreeClean.value,
    targetExists: p.targetExists.value,
    noUnpushedBetween: p.noUnpushedBetween.value,
    noPushedBetween: p.noPushedBetween.value,
    leaksAtTarget: p.leaksAtTarget.value,
    scopeImproves: p.scopeImproves.value,
  };
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
