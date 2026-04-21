import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { normalize } from "node:path";
import { promisify } from "node:util";
import { VERSION } from "@aidrift/core";
import { ApiClient, ApiError } from "./api-client";
import { ClaudeCodeWatcher, type WatcherPersistence } from "./watchers/claude-code-watcher";
import { CodexWatcher } from "./watchers/codex-watcher";
import { SessionManager } from "./session-manager";
import { StatusPoller } from "./status-poller";
import { TaskWatcher } from "./task-watcher";
import { GitWatcher } from "./watchers/git-watcher";
import { SessionsTreeProvider, type SessionTreeItem } from "./views/sessions-tree";
import { runSessionSearch } from "./views/session-search";
import { registerUriHandler, openDiffInVscode } from "./diff-handler";
import { reconcileGitCommits } from "./git-reconciler";
import { SessionDetailPanel } from "./views/session-detail-webview";
import { ProfileManager, DEFAULT_API_URL, DEFAULT_DASHBOARD_URL } from "./profile-manager";
import { BrowserSignIn } from "./browser-signin";

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
let profiles: ProfileManager;
let browserSignIn: BrowserSignIn;
let sessionManager: SessionManager;
let extensionContext: vscode.ExtensionContext;
let claudeWatcher: ClaudeCodeWatcher | undefined;
let codexWatcher: CodexWatcher | undefined;
let taskWatcher: TaskWatcher | undefined;
let gitWatcher: GitWatcher | undefined;
let poller: StatusPoller | undefined;
let treeProvider: SessionsTreeProvider | undefined;
let treeView: vscode.TreeView<SessionTreeItem> | undefined;

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
  extensionContext = context;
  profiles = new ProfileManager(context);
  await profiles.init();
  context.subscriptions.push({ dispose: () => profiles.dispose() });

  apiClient = new ApiClient(context.secrets, profiles);
  browserSignIn = new BrowserSignIn(context, apiClient, profiles, async ({ previousEmail, newEmail }) => {
    // Match the command-palette sign-in paths (loginFlow, loginWithTokenFlow):
    // if the authenticated account changed, tear down the watchers so the
    // fresh start replays every on-disk JSONL against the new user —
    // otherwise previously-cached session-hint → id mappings would route
    // new turns to the old user's sessions (→ 404s, "missing" sessions).
    // Always reset() the session manager for the same reason.
    if (previousEmail && previousEmail !== newEmail) {
      await stopWatchers();
    }
    sessionManager.reset();
    await refreshSignInState();
  });
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
  treeView = vscode.window.createTreeView<SessionTreeItem>("aidrift.sessions", {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);
  treeProvider.startAutoRefresh();
  context.subscriptions.push({ dispose: () => treeProvider?.stopAutoRefresh() });

  context.subscriptions.push(
    vscode.commands.registerCommand("aidrift.login", () => loginChooser()),
    vscode.commands.registerCommand("aidrift.loginWithBrowser", () => browserSignIn.startSignIn()),
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
    vscode.commands.registerCommand("aidrift.openSessionWebview", (sessionId?: string) => {
      if (!sessionId) return;
      void openSessionInEditor(sessionId, undefined);
    }),
    vscode.commands.registerCommand("aidrift.refreshSessions", () => treeProvider?.refresh()),
    vscode.commands.registerCommand("aidrift.searchSessions", () => runSessionSearch(apiClient)),
    vscode.commands.registerCommand("aidrift.switchProfile", () => switchProfileFlow()),
    vscode.commands.registerCommand("aidrift.addProfile", () => addProfileFlow()),
    vscode.commands.registerCommand("aidrift.editProfile", () => editProfileFlow()),
    vscode.commands.registerCommand("aidrift.removeProfile", () => removeProfileFlow()),
    vscode.commands.registerCommand("aidrift.showCurrentProfile", () => showCurrentProfileFlow()),
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
    registerUriHandler({
      workspaceRoots,
      onSignInCallback: (params) => browserSignIn.handleCallback(params),
      onOpenSession: (sessionId, workspacePath) => openSessionInEditor(sessionId, workspacePath),
    }),
  );

  // Rebuild watchers + tree whenever the user switches profiles.
  profiles.onDidChange(async () => {
    await stopWatchers();
    sessionManager.reset();
    treeProvider?.refresh();
    updateStatusBar();
    if (await apiClient.isSignedIn()) {
      await startWatchers();
    }
  });

  updateStatusBar();
  await refreshSignInState();

  // Start the watcher if already signed in.
  if (await apiClient.isSignedIn()) {
    await startWatchers();
    // Fire-and-forget post-rewrite detection. If the user ran filter-branch,
    // filter-repo, or an interactive rebase that rewrote history, the SHAs
    // stored in GitEvent rows no longer exist on HEAD; the server remaps them
    // by subject. Runs once per activation, per workspace root.
    for (const root of workspaceRoots()) {
      void reconcileGitCommits(apiClient, root);
    }
  }
}

async function refreshSignInState(): Promise<void> {
  const signedIn = await apiClient.isSignedIn();
  await vscode.commands.executeCommand("setContext", "aidrift.signedIn", signedIn);
  updateStatusBar();
  treeProvider?.refresh();
  if (signedIn) {
    await startWatchers();
  }
}

function updateStatusBar(): void {
  if (!statusBar || !profiles) return;
  const name = profiles.getActiveName();
  statusBar.text = `$(pulse) aidrift: ${name}`;
  statusBar.tooltip = new vscode.MarkdownString(
    `**AI Drift profile:** \`${name}\`\n\n` +
      `API: ${profiles.getApiBaseUrl()}\n\n` +
      `[Switch profile](command:aidrift.switchProfile)`,
    true,
  );
  statusBar.command = "aidrift.switchProfile";
}

// Per-watcher byte-offset persistence. Stored in globalState so an extension
// reload skips re-walking every JSONL from byte 0 (the server-side dedup on
// userPromptUuid handles correctness even without this; persistence just
// saves the redundant parse + HTTP roundtrips).
function makeWatcherPersistence(key: string): WatcherPersistence | undefined {
  if (!extensionContext) return undefined;
  return {
    load: () => {
      const stored = extensionContext.globalState.get<Record<string, number>>(key);
      return stored ?? {};
    },
    save: (offsets: Record<string, number>) => {
      void extensionContext.globalState.update(key, offsets);
    },
  };
}

async function startWatchers(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("aidrift");
  if (!claudeWatcher && cfg.get<boolean>("watchClaudeCode", true)) {
    claudeWatcher = new ClaudeCodeWatcher(
      (entry, filePath) => {
        const workspacePath = claudeWorkspaceRootForFile(filePath);
        if (workspacePath === undefined) return Promise.resolve();
        return sessionManager.handleEntry(entry, "claude-code", workspacePath ?? undefined);
      },
      makeWatcherPersistence("aidrift.watcher.claude.offsets"),
    );
    try {
      await claudeWatcher.start();
      console.log("[aidrift] Claude Code watcher started");
    } catch (err) {
      console.error("[aidrift] claude watcher failed:", err);
      claudeWatcher = undefined;
    }
  }
  if (!codexWatcher && cfg.get<boolean>("watchCodex", true)) {
    codexWatcher = new CodexWatcher(
      (entry) => {
        const workspacePath = (entry.kind === "skip" || entry.kind === "ai-title" || entry.kind === "tool-results") ? undefined : entry.workspacePath;
        if (!isInActiveWorkspace(workspacePath)) return Promise.resolve();
        return sessionManager.handleEntry(entry, "codex", workspacePath);
      },
      makeWatcherPersistence("aidrift.watcher.codex.offsets"),
    );
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
    await refreshSignInState();
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
      {
        label: "$(link-external) Sign in via browser",
        description: "Open the dashboard, login or signup, token sent back automatically",
        value: "browser",
      },
      {
        label: "$(key) Sign in with token",
        description: "Paste a Personal Access Token from the dashboard",
        value: "token",
      },
      {
        label: "$(account) Sign in with email + password",
        description: "Only works if you registered with a password",
        value: "password",
      },
    ],
    { placeHolder: "How do you want to sign in to AI Drift?", ignoreFocusOut: true },
  );
  if (!pick) return;
  if (pick.value === "browser") await browserSignIn.startSignIn();
  else if (pick.value === "token") await loginWithTokenFlow();
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
    await refreshSignInState();
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
  await vscode.commands.executeCommand("setContext", "aidrift.signedIn", false);
  treeProvider?.refresh();
  updateStatusBar();
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
    const turns = await apiClient.request<Array<{ id: string; turnIndex: number }>>(`/sessions/${sid}/turns?limit=1`);
    const last = turns[0];
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
    const turns = await apiClient.request<Array<{ id: string }>>(`/sessions/${sid}/turns?limit=1`);
    const last = turns[0];
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

// Primary handler for "Open session in VSCode". Opens the session's workspace
// folder if it isn't already open, reveals the session in the sidebar tree,
// and pops a native webview panel with turns/commits/scores + resume actions.
async function openSessionInEditor(sessionId: string, workspacePath: string | undefined): Promise<void> {
  const targetOpen =
    !!workspacePath &&
    workspaceRoots().some((r) => r === workspacePath || r === workspacePath.replace(/\/+$/, ""));
  if (workspacePath && !targetOpen) {
    const pick = await vscode.window.showInformationMessage(
      `AI Drift: open ${workspacePath} in a new VSCode window?`,
      "Open",
      "Not now",
    );
    if (pick === "Open") {
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(workspacePath),
        { forceNewWindow: true },
      );
      return; // new window takes over — the URI will fire again there if launched from dashboard
    }
  }

  SessionDetailPanel.show(sessionId, {
    api: apiClient,
    workspaceRoots,
    dashboardUrl: () => profiles.getDashboardUrl(),
    revealInSidebar: revealSessionInSidebar,
  });
}

async function revealSessionInSidebar(sessionId: string): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.view.extension.aidrift");
  } catch {
    /* sidebar not registered — non-fatal */
  }
  const item = treeProvider?.getItemById(sessionId);
  if (item && treeView) {
    try {
      await treeView.reveal(item, { select: true, focus: false, expand: false });
    } catch {
      /* item not in view yet — tree may still be loading */
    }
  }
}

function openSessionInDashboard(sessionId?: string, hash?: string): void {
  const base = profiles.getDashboardUrl();
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

// ---------- profile commands ----------

async function switchProfileFlow(): Promise<void> {
  const items = profiles.list().map((p) => ({
    label: (p.active ? "$(check) " : "$(circle-outline) ") + p.name,
    description: p.config.apiBaseUrl,
    name: p.name,
    alwaysShow: true,
  }));
  items.push({
    label: "$(add) Add profile…",
    description: "Create a new profile (host + user)",
    name: "__add__",
    alwaysShow: true,
  });
  items.push({
    label: "$(edit) Edit profile…",
    description: "Rename or change the API / dashboard URL",
    name: "__edit__",
    alwaysShow: true,
  });
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select AI Drift profile",
    ignoreFocusOut: true,
  });
  if (!pick) return;
  if (pick.name === "__add__") {
    await addProfileFlow();
    return;
  }
  if (pick.name === "__edit__") {
    await editProfileFlow();
    return;
  }
  try {
    await profiles.setActive(pick.name);
    void vscode.window.showInformationMessage(
      `AI Drift profile: ${pick.name} (${profiles.getApiBaseUrl()})`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Switch failed: ${(err as Error).message}`);
  }
}

async function addProfileFlow(): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: "Profile name",
    placeHolder: "e.g. dev, prod, staging",
    ignoreFocusOut: true,
    validateInput: (v) => (/^[a-zA-Z0-9_-]+$/.test(v) ? undefined : "letters, digits, _ or - only"),
  });
  if (!name) return;
  const apiBaseUrl = await vscode.window.showInputBox({
    prompt: "API base URL",
    value: DEFAULT_API_URL,
    ignoreFocusOut: true,
  });
  if (!apiBaseUrl) return;
  const defaultDash = apiBaseUrl.replace(/\/api\/?$/, "") || DEFAULT_DASHBOARD_URL;
  const dashboardUrl = await vscode.window.showInputBox({
    prompt: "Dashboard URL (press Enter to accept)",
    value: defaultDash,
    ignoreFocusOut: true,
  });
  if (dashboardUrl === undefined) return;
  try {
    await profiles.add(name, { apiBaseUrl, dashboardUrl });
    const switchNow = await vscode.window.showQuickPick(
      [
        { label: "Yes, switch now", value: true },
        { label: "No, stay on current", value: false },
      ],
      { placeHolder: `Switch active profile to "${name}"?`, ignoreFocusOut: true },
    );
    if (switchNow?.value) {
      await profiles.setActive(name);
      void vscode.window.showInformationMessage(
        `AI Drift profile: ${name}. Run 'Drift: Sign In' to authenticate.`,
      );
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Add profile failed: ${(err as Error).message}`);
  }
}

async function editProfileFlow(): Promise<void> {
  const items = profiles.list().map((p) => ({
    label: (p.active ? "$(check) " : "$(circle-outline) ") + p.name,
    description: p.config.apiBaseUrl,
    name: p.name,
    config: p.config,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Edit which profile?",
    ignoreFocusOut: true,
  });
  if (!pick) return;

  const newName = await vscode.window.showInputBox({
    prompt: "Profile name",
    value: pick.name,
    ignoreFocusOut: true,
    validateInput: (v) => (/^[a-zA-Z0-9_-]+$/.test(v) ? undefined : "letters, digits, _ or - only"),
  });
  if (!newName) return;

  const newApi = await vscode.window.showInputBox({
    prompt: "API base URL",
    value: pick.config.apiBaseUrl,
    ignoreFocusOut: true,
  });
  if (!newApi) return;

  const defaultDash = pick.config.dashboardUrl
    ?? (newApi.replace(/\/api\/?$/, "") || DEFAULT_DASHBOARD_URL);
  const newDash = await vscode.window.showInputBox({
    prompt: "Dashboard URL",
    value: defaultDash,
    ignoreFocusOut: true,
  });
  if (newDash === undefined) return;

  try {
    if (newName !== pick.name) {
      await profiles.rename(pick.name, newName);
    }
    await profiles.update(newName, { apiBaseUrl: newApi, dashboardUrl: newDash });
    void vscode.window.showInformationMessage(
      `Profile "${newName}" updated (${newApi}).`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Edit failed: ${(err as Error).message}`);
  }
}

async function removeProfileFlow(): Promise<void> {
  const items = profiles.list()
    .filter((p) => !p.active)
    .map((p) => ({
      label: p.name,
      description: p.config.apiBaseUrl,
      name: p.name,
    }));
  if (items.length === 0) {
    void vscode.window.showWarningMessage("No other profiles to remove. Switch profiles first.");
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Remove which profile?",
    ignoreFocusOut: true,
  });
  if (!pick) return;
  const confirm = await vscode.window.showWarningMessage(
    `Remove profile "${pick.name}" and its stored credentials?`,
    { modal: true },
    "Remove",
  );
  if (confirm !== "Remove") return;
  try {
    await profiles.remove(pick.name);
    void vscode.window.showInformationMessage(`Removed profile "${pick.name}".`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Remove failed: ${(err as Error).message}`);
  }
}

async function showCurrentProfileFlow(): Promise<void> {
  const name = profiles.getActiveName();
  const email = await apiClient.getEmail();
  void vscode.window.showInformationMessage(
    `AI Drift profile: ${name} (${profiles.getApiBaseUrl()})` +
      (email ? ` — signed in as ${email}` : " — not signed in"),
  );
}

export async function deactivate(): Promise<void> {
  statusBar?.dispose();
  poller?.stop();
  await stopWatchers();
}
