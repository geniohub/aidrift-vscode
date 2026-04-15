import * as vscode from "vscode";
import { VERSION } from "@aidrift/core";

let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  console.log(`[aidrift] activating v${VERSION}`);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = "$(pulse) Drift —";
  statusBar.tooltip = "AI Drift Detector — no active session";
  statusBar.command = "aidrift.showStatus";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("aidrift.startSession", async () => {
      const task = await vscode.window.showInputBox({
        prompt: "What are you trying to accomplish in this session?",
        placeHolder: "e.g. fix flaky auth test",
      });
      if (!task) return;
      // Phase 2: persist via @aidrift/core
      vscode.window.showInformationMessage(`[Phase 1 stub] Started drift session: ${task}`);
      statusBar.text = "$(pulse) Drift 100 →";
      statusBar.tooltip = `AI Drift Detector — ${task}`;
    }),
    vscode.commands.registerCommand("aidrift.acceptLastTurn", () => {
      vscode.window.showInformationMessage("[Phase 2 stub] accept last turn");
    }),
    vscode.commands.registerCommand("aidrift.rejectLastTurn", () => {
      vscode.window.showInformationMessage("[Phase 2 stub] reject last turn");
    }),
    vscode.commands.registerCommand("aidrift.createCheckpoint", () => {
      vscode.window.showInformationMessage("[Phase 4 stub] create checkpoint");
    }),
    vscode.commands.registerCommand("aidrift.showStatus", () => {
      vscode.window.showInformationMessage("[Phase 4 stub] no active session yet");
    }),
  );

  // Phase 5: spin up ClaudeCodeJSONLWatcher here, subscribe to turns, update statusBar.
}

export function deactivate(): void {
  statusBar?.dispose();
}
