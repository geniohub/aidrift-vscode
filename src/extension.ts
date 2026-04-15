import * as vscode from "vscode";
import { VERSION } from "@aidrift/core";
import { ApiClient, ApiError } from "./api-client";
import { ClaudeCodeWatcher } from "./watchers/claude-code-watcher";
import { SessionManager } from "./session-manager";
import { StatusPoller } from "./status-poller";
import { SessionsTreeProvider } from "./views/sessions-tree";

let statusBar: vscode.StatusBarItem;
let apiClient: ApiClient;
let sessionManager: SessionManager;
let watcher: ClaudeCodeWatcher | undefined;
let poller: StatusPoller | undefined;
let treeProvider: SessionsTreeProvider | undefined;

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
    vscode.commands.registerCommand("aidrift.login", () => loginFlow()),
    vscode.commands.registerCommand("aidrift.logout", () => logoutFlow()),
    vscode.commands.registerCommand("aidrift.whoami", () => whoamiFlow()),
    vscode.commands.registerCommand("aidrift.acceptLastTurn", () => setLastTurnOutcome("accepted")),
    vscode.commands.registerCommand("aidrift.rejectLastTurn", () => setLastTurnOutcome("rejected")),
    vscode.commands.registerCommand("aidrift.createCheckpoint", () => createCheckpointFlow()),
    vscode.commands.registerCommand("aidrift.showStatus", () => showStatusFlow()),
    vscode.commands.registerCommand("aidrift.openActiveInDashboard", () => openActiveInDashboard()),
    vscode.commands.registerCommand("aidrift.openSessionInDashboard", (sessionId?: string) => openSessionInDashboard(sessionId)),
    vscode.commands.registerCommand("aidrift.refreshSessions", () => treeProvider?.refresh()),
  );

  // Start the watcher if already signed in.
  if (await apiClient.isSignedIn()) {
    await startWatcher();
  }
}

async function startWatcher(): Promise<void> {
  if (watcher) return;
  if (!vscode.workspace.getConfiguration("aidrift").get<boolean>("watchClaudeCode", true)) return;
  watcher = new ClaudeCodeWatcher(async (entry) => {
    await sessionManager.handleEntry(entry);
  });
  try {
    await watcher.start();
    console.log("[aidrift] Claude Code watcher started");
  } catch (err) {
    console.error("[aidrift] watcher failed to start:", err);
    watcher = undefined;
  }
}

async function stopWatcher(): Promise<void> {
  await watcher?.stop();
  watcher = undefined;
}

// ---------- commands ----------

async function loginFlow(): Promise<void> {
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
    void vscode.window.showInformationMessage(`Signed in to AI Drift as ${user.email}`);
    await startWatcher();
  } catch (err) {
    const msg = err instanceof ApiError
      ? `Sign-in failed: ${err.message}`
      : `Sign-in failed: ${(err as Error).message}`;
    void vscode.window.showErrorMessage(msg);
  }
}

async function logoutFlow(): Promise<void> {
  await apiClient.logout();
  await stopWatcher();
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
    await apiClient.request(`/sessions/${sid}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ turnId: last.id, summary, source: "manual" }),
    });
    void vscode.window.showInformationMessage(`Checkpoint created.`);
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

function openActiveInDashboard(): void {
  openSessionInDashboard(sessionManager.getActiveSessionId() ?? undefined);
}

function openSessionInDashboard(sessionId?: string): void {
  const base = vscode.workspace.getConfiguration("aidrift").get<string>("dashboardUrl") ?? "http://localhost:3331";
  const url = sessionId ? `${base}/sessions/${sessionId}` : `${base}/sessions`;
  void vscode.env.openExternal(vscode.Uri.parse(url));
}

export async function deactivate(): Promise<void> {
  statusBar?.dispose();
  poller?.stop();
  await stopWatcher();
}
