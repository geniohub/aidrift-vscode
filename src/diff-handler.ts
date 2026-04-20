// URI handler for vscode://geniohub.aidrift/diff?fromSha=...&toSha=...
// Opens VSCode's native side-by-side diff via the built-in Git extension API.

import * as vscode from "vscode";

interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri?: vscode.Uri;
  readonly status: number;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
  fetch?(options?: { remote?: string; ref?: string }): Promise<void>;
}

interface GitApi {
  readonly repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

function getGitApi(): GitApi | undefined {
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : undefined;
  return exports?.getAPI(1);
}

function pickRepository(api: GitApi, workspaceRoots: string[]): GitRepository | undefined {
  if (api.repositories.length === 0) return undefined;
  if (api.repositories.length === 1) return api.repositories[0];
  // Prefer a repo whose root matches one of the session's workspace roots.
  for (const root of workspaceRoots) {
    const match = api.repositories.find((r) => r.rootUri.fsPath === root);
    if (match) return match;
  }
  return api.repositories[0];
}

function gitResourceUri(repo: GitRepository, filePath: string, ref: string): vscode.Uri {
  const absolute = vscode.Uri.joinPath(repo.rootUri, filePath);
  return absolute.with({
    scheme: "git",
    path: absolute.path,
    query: JSON.stringify({ path: absolute.fsPath, ref }),
  });
}

export interface OpenDiffArgs {
  fromSha?: string;
  toSha?: string;
  filePath?: string;
  workspaceRoots: string[];
}

export async function openDiffInVscode(args: OpenDiffArgs): Promise<void> {
  const { fromSha, toSha, filePath, workspaceRoots } = args;
  if (!fromSha || !toSha) {
    void vscode.window.showWarningMessage("AI Drift: diff link is missing fromSha or toSha.");
    return;
  }

  const api = getGitApi();
  if (!api) {
    void vscode.window.showErrorMessage(
      "AI Drift: the built-in Git extension is unavailable. Enable it and retry.",
    );
    return;
  }

  const repo = pickRepository(api, workspaceRoots);
  if (!repo) {
    void vscode.window.showWarningMessage(
      "AI Drift: no git repository open. Open the session's workspace, then retry the diff link.",
    );
    return;
  }

  let changes: GitChange[];
  try {
    changes = await repo.diffBetween(fromSha, toSha);
  } catch (err) {
    // Likely: one of the SHAs isn't in the local repo. Try a fetch and retry once.
    try {
      await repo.fetch?.();
      changes = await repo.diffBetween(fromSha, toSha);
    } catch (err2) {
      void vscode.window.showErrorMessage(
        `AI Drift: couldn't diff ${fromSha.slice(0, 7)}…${toSha.slice(0, 7)} — ${(err2 as Error).message}`,
      );
      return;
    }
  }

  if (changes.length === 0) {
    void vscode.window.showInformationMessage(
      `AI Drift: no file changes between ${fromSha.slice(0, 7)} and ${toSha.slice(0, 7)}.`,
    );
    return;
  }

  // If a specific file was requested, diff that one directly.
  if (filePath) {
    const change = changes.find((c) => c.uri.fsPath.endsWith(filePath));
    if (change) {
      await openOneDiff(repo, change, fromSha, toSha);
      return;
    }
  }

  // Otherwise let the user pick from the changed file list.
  const picks = changes.map((c) => {
    const rel = vscode.workspace.asRelativePath(c.uri, false);
    return {
      label: rel,
      description: `${fromSha.slice(0, 7)} → ${toSha.slice(0, 7)}`,
      change: c,
    };
  });
  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: `${changes.length} file(s) changed — pick one to diff`,
    matchOnDescription: false,
  });
  if (!chosen) return;
  await openOneDiff(repo, chosen.change, fromSha, toSha);
}

async function openOneDiff(
  repo: GitRepository,
  change: GitChange,
  fromSha: string,
  toSha: string,
): Promise<void> {
  const rel = vscode.workspace.asRelativePath(change.uri, false);
  const leftPath = vscode.workspace.asRelativePath(change.originalUri, false);
  const left = gitResourceUri(repo, leftPath, fromSha);
  const right = gitResourceUri(repo, rel, toSha);
  const title = `${rel} (${fromSha.slice(0, 7)} ↔ ${toSha.slice(0, 7)})`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title);
}

// Open the AI Drift sidebar on the given session. If the session's workspace
// isn't currently open in any folder, surface a soft toast that offers to
// open it in a new window (so we don't clobber the user's current state).
export interface OpenSessionArgs {
  sessionId?: string;
  workspacePath?: string;
  currentWorkspaceRoots: string[];
}

export async function openSessionInVscode(args: OpenSessionArgs): Promise<void> {
  const { sessionId, workspacePath, currentWorkspaceRoots } = args;
  const targetOpen =
    !!workspacePath &&
    currentWorkspaceRoots.some((r) => r === workspacePath || r === workspacePath.replace(/\/+$/, ""));

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
      return;
    }
    // User declined — still focus the sidebar in this window so they can at
    // least see the list of sessions.
  }

  try {
    await vscode.commands.executeCommand("workbench.view.extension.aidrift");
  } catch {
    /* sidebar not registered — non-fatal */
  }

  if (sessionId) {
    void vscode.window.setStatusBarMessage(
      `AI Drift: session …${sessionId.slice(-6)} focused`,
      3000,
    );
  }
}

export interface UriHandlerOptions {
  workspaceRoots: () => string[];
  onSignInCallback: (query: URLSearchParams) => Promise<void>;
}

export function registerUriHandler(options: UriHandlerOptions): vscode.Disposable {
  return vscode.window.registerUriHandler({
    handleUri(uri: vscode.Uri): void {
      const params = new URLSearchParams(uri.query);
      if (uri.path === "/diff") {
        const fromSha = params.get("fromSha") ?? undefined;
        const toSha = params.get("toSha") ?? undefined;
        const filePath = params.get("filePath") ?? undefined;
        void openDiffInVscode({
          fromSha,
          toSha,
          filePath,
          workspaceRoots: options.workspaceRoots(),
        });
        return;
      }
      if (uri.path === "/session") {
        const sessionId = params.get("id") ?? undefined;
        const workspacePath = params.get("workspacePath") ?? undefined;
        void openSessionInVscode({
          sessionId,
          workspacePath,
          currentWorkspaceRoots: options.workspaceRoots(),
        });
        return;
      }
      if (uri.path === "/callback") {
        void options.onSignInCallback(params);
        return;
      }
      void vscode.window.showWarningMessage(`AI Drift: unknown URI path ${uri.path}`);
    },
  });
}
