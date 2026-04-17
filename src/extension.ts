import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { normalize } from "node:path";
import { promisify } from "node:util";
import { VERSION } from "@aidrift/core";
import { ApiClient, ApiError } from "./api-client";
import { ClaudeCodeWatcher } from "./watchers/claude-code-watcher";
import { CodexWatcher } from "./watchers/codex-watcher";
import { SessionManager } from "./session-manager";
import { StatusPoller } from "./status-poller";
import { TaskWatcher } from "./task-watcher";
import { GitWatcher } from "./watchers/git-watcher";
import { SessionsTreeProvider } from "./views/sessions-tree";
import { registerDiffUriHandler, openDiffInVscode } from "./diff-handler";

const execFileAsync = promisify(execFile);

async function currentHeadSha(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

let statusBar: vscode.StatusBarItem;
let apiClient: ApiClient;
let sessionManager: SessionManager;
let claudeWatcher: ClaudeCodeWatcher | undefined;
let codexWatcher: CodexWatcher | undefined;
let taskWatcher: TaskWatcher | undefined;
let gitWatcher: GitWatcher | undefined;
let poller: StatusPoller | undefined;
let treeProvider: SessionsTreeProvider | undefined;

function normalizeWorkspacePath(p: string): string {
  return normalize(p).replace(/[\\\/]+$/, "");
}

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .map((f) => normalizeWorkspacePath(f.uri.fsPath))
    .filter(Boolean);
}

function claudeProjectSlugFromWorkspacePath(workspacePath: string): string {
  return normalizeWorkspacePath(workspacePath).replace(/\\/g, "/").replace(/\//g, "-");
}

function firstWorkspaceRoot(): string | undefined {
  return workspaceRoots()[0];
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  const c = normalizeWorkspacePath(candidate);
  const r = normalizeWorkspacePath(root);
  return c === r || c.startsWith(`${r}/`) || c.startsWith(`${r}\\`);
}

function isInActiveWorkspace(candidatePath: string | undefined): boolean {
  const roots = workspaceRoots();
  if (roots.length === 0) return true;
  if (!candidatePath) return false;
  return roots.some((root) => isSameOrChildPath(candidatePath, root));
}

function claudeProjectSlugFromFile(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const marker = "/.claude/projects/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) return undefined;
  const rest = normalized.slice(idx + marker.length);
  const slug = rest.split("/")[0];
  if (!slug) return undefined;
  return slug;
}

function claudeWorkspaceRootForFile(filePath: string): string | null | undefined {
  const roots = workspaceRoots();
  if (roots.length === 0) return null;
  const slug = claudeProjectSlugFromFile(filePath);
  if (!slug) return undefined;
  return roots.find((root) => claudeProjectSlugFromWorkspacePath(root) === slug);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log(`[aidrift] activating v${VERSION}`);
  apiClient = new ApiClient(context.secrets);
  sessionManager = new SessionManager(apiClient);
  sessionManager.start();
  context.subscriptions.push({ dispose: () => sessionManager.stop() });

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.show();
  context.subscriptions.push(statusBar);

  poller = new StatusPoller(
    apiClient,
    statusBar,
    () => sessionManager.getActiveSessionId(),
    () => sessionManager.getActiveTaskDescription(),
    () => firstWorkspaceRoot(),
    () => sessionManager.clearActiveSession(),
  );
  poller.start();
  context.subscriptions.push({ dispose: () => poller?.stop() });

  treeProvider = new SessionsTreeProvider(apiClient);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("aidrift.sessions", treeProvider),
  );
  treeProvider.startAutoRefresh();
  context.subscriptions.push({ dispose: () => treeProvider?.stopAutoRefresh() });

  context.subscriptions.push(
    vscode.commands.registerCommand("aidrift.login", () => loginChooser()),
    vscode.commands.registerCommand("aidrift.loginWithToken", () => loginWithTokenFlow()),
    vscode.commands.registerCommand("aidrift.loginWithPassword", () => loginFlow()),
    vscode.commands.registerCommand("aidrift.logout", () => logoutFlow()),
    vscode.commands.registerCommand("aidrift.whoami", () => whoamiFlow()),
    vscode.commands.registerCommand("aidrift.acceptLastTurn", () => setLastTurnOutcome("accepted")),
    vscode.commands.registerCommand("aidrift.rejectLastTurn", () => setLastTurnOutcome("rejected")),
    vscode.commands.registerCommand("aidrift.createCheckpoint", () => createCheckpointFlow()),
    vscode.commands.registerCommand("aidrift.revertToLastCheckpoint", () => revertToLastCheckpoint()),
    vscode.commands.registerCommand("aidrift.showStatus", () => showStatusFlow()),
    vscode.commands.registerCommand("aidrift.debugTracking", () => debugTrackingFlow()),
    vscode.commands.registerCommand("aidrift.openActiveInDashboard", () => openActiveInDashboard()),
    vscode.commands.registerCommand("aidrift.openSessionInDashboard", (sessionId?: string) => openSessionInDashboard(sessionId)),
    vscode.commands.registerCommand("aidrift.refreshSessions", () => treeProvider?.refresh()),
    vscode.commands.registerCommand(
      "aidrift.openDiff",
      (args: { fromSha?: string; toSha?: string; filePath?: string } | undefined) =>
        openDiffInVscode({
          fromSha: args?.fromSha,
          toSha: args?.toSha,
          filePath: args?.filePath,
          workspaceRoots: workspaceRoots(),
        }),
    ),
  );
  context.subscriptions.push(
    registerDiffUriHandler({
      workspaceRoots,
    }),
  );

  // Start the watcher if already signed in.
  if (await apiClient.isSignedIn()) {
    await startWatchers();
  }
}

async function startWatchers(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("aidrift");
  if (!claudeWatcher && cfg.get<boolean>("watchClaudeCode", true)) {
    claudeWatcher = new ClaudeCodeWatcher((entry, filePath) => {
      const workspacePath = claudeWorkspaceRootForFile(filePath);
      if (workspacePath === undefined) return Promise.resolve();
      return sessionManager.handleEntry(entry, "claude-code", workspacePath ?? undefined);
    });
    try {
      await claudeWatcher.start();
      console.log("[aidrift] Claude Code watcher started");
    } catch (err) {
      console.error("[aidrift] claude watcher failed:", err);
      claudeWatcher = undefined;
    }
  }
  if (!codexWatcher && cfg.get<boolean>("watchCodex", true)) {
    codexWatcher = new CodexWatcher((entry) => {
      const workspacePath = (entry.kind === "skip" || entry.kind === "ai-title" || entry.kind === "tool-results") ? undefined : entry.workspacePath;
      if (!isInActiveWorkspace(workspacePath)) return Promise.resolve();
      return sessionManager.handleEntry(entry, "codex", workspacePath);
    });
    try {
      await codexWatcher.start();
      console.log("[aidrift] Codex watcher started");
    } catch (err) {
      console.error("[aidrift] codex watcher failed:", err);
      codexWatcher = undefined;
    }
  }
  if (!taskWatcher && cfg.get<boolean>("trackTaskExecution", true)) {
    taskWatcher = new TaskWatcher(apiClient, sessionManager);
    taskWatcher.start();
    console.log("[aidrift] Task watcher started");
  }
  if (!gitWatcher && cfg.get<boolean>("watchGitEvents", true)) {
    gitWatcher = new GitWatcher(
      apiClient,
      () => sessionManager.getActiveSessionId(),
      () => sessionManager.getLastTurnId(),
      workspaceRoots,
    );
    try {
      await gitWatcher.start();
      console.log("[aidrift] Git watcher started");
    } catch (err) {
      console.error("[aidrift] git watcher failed:", err);
      gitWatcher = undefined;
    }
  }
}

async function stopWatchers(): Promise<void> {
  await claudeWatcher?.stop();
  claudeWatcher = undefined;
  await codexWatcher?.stop();
  codexWatcher = undefined;
  taskWatcher?.stop();
  taskWatcher = undefined;
  await gitWatcher?.stop();
  gitWatcher = undefined;
}

// ---------- commands ----------

async function loginFlow(): Promise<void> {
  const previousEmail = await apiClient.getEmail();
  const email = await vscode.window.showInputBox({
    prompt: "Email",
    placeHolder: "you@example.com",
    ignoreFocusOut: true,
  });
  if (!email) return;
  const password = await vscode.window.showInputBox({
    prompt: "Password",
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return;
  try {
    const user = await apiClient.login(email, password);
    if (previousEmail && previousEmail !== user.email) {
      await stopWatchers();
    }
    sessionManager.reset();
    void vscode.window.showInformationMessage(`Signed in to AI Drift as ${user.email}`);
    await startWatchers();
  } catch (err) {
    const msg = err instanceof ApiError
      ? `Sign-in failed: ${err.message}`
      : `Sign-in failed: ${(err as Error).message}`;
    void vscode.window.showErrorMessage(msg);
  }
}

async function loginChooser(): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: "Sign in with token", description: "Paste a Personal Access Token from the dashboard (works with Google accounts)", value: "token" },
      { label: "Sign in with email + password", description: "Only works if you registered with a password", value: "password" },
    ],
    { placeHolder: "How do you want to sign in to AI Drift?", ignoreFocusOut: true },
  );
  if (!pick) return;
  if (pick.value === "token") await loginWithTokenFlow();
  else await loginFlow();
}

async function loginWithTokenFlow(): Promise<void> {
  const previousEmail = await apiClient.getEmail();
  const token = await vscode.window.showInputBox({
    prompt: "Paste your AI Drift Personal Access Token",
    placeHolder: "aidrift_pat_…",
    password: true,
    ignoreFocusOut: true,
  });
  if (!token) return;
  try {
    const user = await apiClient.loginWithToken(token.trim());
    if (previousEmail && previousEmail !== user.email) {
      await stopWatchers();
    }
    sessionManager.reset();
    void vscode.window.showInformationMessage(`Signed in to AI Drift as ${user.email}`);
    await startWatchers();
  } catch (err) {
    const msg = err instanceof ApiError
      ? `Token sign-in failed: ${err.message}`
      : `Token sign-in failed: ${(err as Error).message}`;
    void vscode.window.showErrorMessage(msg);
  }
}

async function logoutFlow(): Promise<void> {
  await apiClient.logout();
  await stopWatchers();
  sessionManager.reset();
  void vscode.window.showInformationMessage("Signed out of AI Drift");
}

async function whoamiFlow(): Promise<void> {
  const email = await apiClient.getEmail();
  if (!email) {
    void vscode.window.showWarningMessage("Not signed in. Run 'Drift: Sign In'.");
    return;
  }
  try {
    const me = await apiClient.request<{ email: string; id: string }>("/auth/me");
    void vscode.window.showInformationMessage(`Signed in as ${me.email} (${me.id})`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      void vscode.window.showWarningMessage("Session expired. Run 'Drift: Sign In' again.");
    } else {
      void vscode.window.showErrorMessage(`AI Drift API unreachable: ${(err as Error).message}`);
    }
  }
}

async function setLastTurnOutcome(outcome: "accepted" | "rejected"): Promise<void> {
  const sid = sessionManager.getActiveSessionId();
  if (!sid) {
    void vscode.window.showWarningMessage("No active drift session yet.");
    return;
  }
  try {
    const turns = await apiClient.request<Array<{ id: string; turnIndex: number }>>(`/sessions/${sid}/turns`);
    const last = turns.at(-1);
    if (!last) {
      void vscode.window.showWarningMessage("No turns in the active session yet.");
      return;
    }
    await apiClient.request(`/turns/${last.id}/outcome`, {
      method: "PATCH",
      body: JSON.stringify({ outcome }),
    });
    void vscode.window.showInformationMessage(`Marked turn #${last.turnIndex} as ${outcome}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed: ${(err as Error).message}`);
  }
}

async function createCheckpointFlow(): Promise<void> {
  const sid = sessionManager.getActiveSessionId();
  if (!sid) {
    void vscode.window.showWarningMessage("No active drift session yet.");
    return;
  }
  const summary = await vscode.window.showInputBox({
    prompt: "Checkpoint summary",
    placeHolder: "e.g. auth tests green",
  });
  if (!summary) return;
  try {
    const turns = await apiClient.request<Array<{ id: string }>>(`/sessions/${sid}/turns`);
    const last = turns.at(-1);
    if (!last) {
      void vscode.window.showWarningMessage("No turns yet.");
      return;
    }
    const root = firstWorkspaceRoot();
    const gitSha = root ? await currentHeadSha(root) : undefined;
    await apiClient.request(`/sessions/${sid}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ turnId: last.id, summary, source: "manual", gitSha }),
    });
    void vscode.window.showInformationMessage(
      gitSha
        ? `Checkpoint created (git ${gitSha.slice(0, 7)}).`
        : `Checkpoint created.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed: ${(err as Error).message}`);
  }
}

function showStatusFlow(): void {
  const status = poller?.getLastStatus();
  if (!status) {
    void vscode.window.showInformationMessage("No drift status yet.");
    return;
  }
  const alertLine = status.alert.active
    ? ` — ⚠ drift: ${status.alert.reasons.join("; ")}`
    : "";
  void vscode.window.showInformationMessage(
    `${status.session.taskDescription} — score ${status.currentScore ?? "—"} (${status.trend})${alertLine}`,
  );
}

async function debugTrackingFlow(): Promise<void> {
  const workspacePath = firstWorkspaceRoot();
  const watchClaude = vscode.workspace.getConfiguration("aidrift").get<boolean>("watchClaudeCode", true);
  const watchCodex = vscode.workspace.getConfiguration("aidrift").get<boolean>("watchCodex", true);
  const email = await apiClient.getEmail();

  const lines: string[] = [];
  lines.push(`signed in: ${email ?? "no"}`);
  lines.push(`workspace: ${workspacePath ?? "(none)"}`);
  lines.push(`active session: ${sessionManager.getActiveSessionId() ?? "(none)"}`);
  lines.push(`watchClaudeCode: ${watchClaude} (${claudeWatcher ? "running" : "stopped"})`);
  lines.push(`watchCodex: ${watchCodex} (${codexWatcher ? "running" : "stopped"})`);

  try {
    const query = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : "";
    const tracking = await apiClient.request<{
      hasRecentActivity: boolean;
      sessionsTotal: number;
      sessionsOpen: number;
      turnsLast24h: number;
      lastTurnAt: string | null;
      sourceBreakdown: Array<{ source: string; count: number }>;
      recommendations: string[];
    }>(`/tracking/health${query}`);
    lines.push(`recent activity: ${tracking.hasRecentActivity}`);
    lines.push(`sessions: total=${tracking.sessionsTotal}, open=${tracking.sessionsOpen}`);
    lines.push(`turns (24h): ${tracking.turnsLast24h}`);
    lines.push(`last turn: ${tracking.lastTurnAt ?? "(none)"}`);
    const src = tracking.sourceBreakdown
      .slice(0, 5)
      .map((s) => `${s.source}:${s.count}`)
      .join(", ");
    lines.push(`sources: ${src || "(none)"}`);
    if (tracking.recommendations.length > 0) {
      lines.push("recommendations:");
      for (const r of tracking.recommendations) lines.push(`- ${r}`);
    }
  } catch (err) {
    lines.push(`tracking api error: ${(err as Error).message}`);
  }

  void vscode.window.showInformationMessage("AI Drift tracking diagnostics copied to output.");
  const channel = vscode.window.createOutputChannel("AI Drift Tracking");
  channel.clear();
  channel.appendLine(lines.join("\n"));
  channel.show(true);
}

function openActiveInDashboard(): void {
  openSessionInDashboard(sessionManager.getActiveSessionId() ?? undefined);
}

function openSessionInDashboard(sessionId?: string, hash?: string): void {
  const base = vscode.workspace.getConfiguration("aidrift").get<string>("dashboardUrl") ?? "http://localhost:3331";
  const workspacePath = firstWorkspaceRoot();
  const query = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : "";
  const fragment = hash ? `#${hash.replace(/^#/, "")}` : "";
  const url = sessionId
    ? `${base}/sessions/${sessionId}${query}${fragment}`
    : `${base}/sessions${query}`;
  void vscode.env.openExternal(vscode.Uri.parse(url));
}

function revertToLastCheckpoint(): void {
  const status = poller?.getLastStatus();
  if (!status) {
    void vscode.window.showInformationMessage("No drift status yet.");
    return;
  }
  const cp = status.lastStableCheckpoint;
  if (!cp) {
    void vscode.window.showInformationMessage(
      "No stable checkpoint to revert to yet. Mark an accepted turn as a checkpoint first.",
    );
    return;
  }
  openSessionInDashboard(status.session.id, `turn-${cp.turnId}`);
}

export async function deactivate(): Promise<void> {
  statusBar?.dispose();
  poller?.stop();
  await stopWatchers();
}
