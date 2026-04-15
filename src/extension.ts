import * as vscode from "vscode";
import { VERSION } from "@aidrift/core";
import { ApiClient, ApiError } from "./api-client";

let statusBar: vscode.StatusBarItem;
let apiClient: ApiClient;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log(`[aidrift] activating v${VERSION}`);
  apiClient = new ApiClient(context.secrets);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.show();
  context.subscriptions.push(statusBar);
  await refreshStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand("aidrift.login", () => loginFlow()),
    vscode.commands.registerCommand("aidrift.logout", () => logoutFlow()),
    vscode.commands.registerCommand("aidrift.whoami", () => whoamiFlow()),
    vscode.commands.registerCommand("aidrift.startSession", () => stub("startSession", "Phase 3")),
    vscode.commands.registerCommand("aidrift.acceptLastTurn", () => stub("acceptLastTurn", "Phase 3")),
    vscode.commands.registerCommand("aidrift.rejectLastTurn", () => stub("rejectLastTurn", "Phase 3")),
    vscode.commands.registerCommand("aidrift.createCheckpoint", () => stub("createCheckpoint", "Phase 5")),
    vscode.commands.registerCommand("aidrift.showStatus", () => stub("showStatus", "Phase 5")),
  );
}

async function refreshStatusBar(): Promise<void> {
  const email = await apiClient.getEmail();
  if (email) {
    statusBar.text = "$(pulse) Drift —";
    statusBar.tooltip = `Signed in as ${email} — no active session yet`;
    statusBar.command = "aidrift.showStatus";
  } else {
    statusBar.text = "$(account) Drift: sign in";
    statusBar.tooltip = "Click to sign in to AI Drift";
    statusBar.command = "aidrift.login";
  }
}

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
    await refreshStatusBar();
    void vscode.window.showInformationMessage(`Signed in to AI Drift as ${user.email}`);
  } catch (err) {
    const msg = err instanceof ApiError
      ? `Sign-in failed: ${err.message}`
      : `Sign-in failed: ${(err as Error).message}`;
    void vscode.window.showErrorMessage(msg);
  }
}

async function logoutFlow(): Promise<void> {
  await apiClient.logout();
  await refreshStatusBar();
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

function stub(_cmd: string, phase: string): void {
  void vscode.window.showInformationMessage(`[${phase} stub] not implemented yet`);
}

export function deactivate(): void {
  statusBar?.dispose();
}
