// GitWatcher: monitors .git/refs/heads/* and .git/refs/remotes/* for changes
// to detect commits and pushes. Runs `git log` and `git diff --stat` to
// extract commit details, then posts them to the API.

import * as vscode from "vscode";
import chokidar, { type FSWatcher } from "chokidar";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ApiClient } from "../api-client.js";

const execFileAsync = promisify(execFile);

export interface GitEventPayload {
  type: "commit" | "push" | "branch_create" | "branch_switch";
  commitHash?: string;
  commitShort?: string;
  commitMessage?: string;
  branch: string;
  remote?: string;
  author?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  aiInitiated: boolean;
  turnId?: string;
}

type SessionIdGetter = () => string | null;

// Debounce interval: git operations often touch multiple ref files rapidly
const DEBOUNCE_MS = 1500;

export class GitWatcher {
  private headWatcher: FSWatcher | undefined;
  private remoteWatcher: FSWatcher | undefined;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private lastHeadCommit = new Map<string, string>(); // branch → hash
  private lastRemoteCommit = new Map<string, string>(); // remote/branch → hash

  constructor(
    private readonly api: ApiClient,
    private readonly getSessionId: SessionIdGetter,
    private readonly getLastTurnId: () => string | null,
    private readonly workspaceRoots: () => string[],
  ) {}

  async start(): Promise<void> {
    const roots = this.workspaceRoots();
    if (roots.length === 0) return;

    for (const root of roots) {
      const gitDir = join(root, ".git");
      const headsDir = join(gitDir, "refs", "heads");
      const remotesDir = join(gitDir, "refs", "remotes");

      // Seed current HEAD so we don't fire on startup
      await this.seedCurrentHead(root);

      this.headWatcher = chokidar.watch(headsDir, {
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
      });
      this.headWatcher.on("change", (filePath) => {
        this.debounce(`head:${filePath}`, () => void this.onHeadChange(root, filePath));
      });
      this.headWatcher.on("add", (filePath) => {
        this.debounce(`head:${filePath}`, () => void this.onBranchCreate(root, filePath));
      });

      this.remoteWatcher = chokidar.watch(remotesDir, {
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
      });
      this.remoteWatcher.on("change", (filePath) => {
        this.debounce(`remote:${filePath}`, () => void this.onRemoteChange(root, filePath));
      });
    }
  }

  async stop(): Promise<void> {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    await this.headWatcher?.close();
    this.headWatcher = undefined;
    await this.remoteWatcher?.close();
    this.remoteWatcher = undefined;
  }

  private debounce(key: string, fn: () => void): void {
    const prev = this.debounceTimers.get(key);
    if (prev) clearTimeout(prev);
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, DEBOUNCE_MS));
  }

  private async seedCurrentHead(root: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
      const hash = stdout.trim();
      const branch = await this.getCurrentBranch(root);
      if (branch && hash) this.lastHeadCommit.set(branch, hash);
    } catch {
      // not a git repo or git not available
    }
  }

  private async getCurrentBranch(root: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private branchFromRefPath(filePath: string): string {
    // .git/refs/heads/feature/foo → feature/foo
    const marker = "/refs/heads/";
    const idx = filePath.indexOf(marker);
    return idx >= 0 ? filePath.slice(idx + marker.length) : filePath.split("/").pop() ?? "unknown";
  }

  private remoteBranchFromRefPath(filePath: string): { remote: string; branch: string } {
    // .git/refs/remotes/origin/main → { remote: "origin", branch: "main" }
    const marker = "/refs/remotes/";
    const idx = filePath.indexOf(marker);
    const rest = idx >= 0 ? filePath.slice(idx + marker.length) : filePath;
    const parts = rest.split("/");
    const remote = parts[0] ?? "origin";
    const branch = parts.slice(1).join("/") || "main";
    return { remote, branch };
  }

  private async onHeadChange(root: string, filePath: string): Promise<void> {
    const branch = this.branchFromRefPath(filePath);
    const commitInfo = await this.getLatestCommitInfo(root);
    if (!commitInfo) return;

    // Skip if we already reported this commit
    const prev = this.lastHeadCommit.get(branch);
    if (prev === commitInfo.hash) return;
    this.lastHeadCommit.set(branch, commitInfo.hash);

    // Check if this commit was AI-initiated by looking at tool calls
    const aiInitiated = await this.isAiInitiatedCommit(commitInfo.message);

    const payload: GitEventPayload = {
      type: "commit",
      commitHash: commitInfo.hash,
      commitShort: commitInfo.hash.slice(0, 7),
      commitMessage: commitInfo.message,
      branch,
      author: commitInfo.author,
      filesChanged: commitInfo.filesChanged,
      insertions: commitInfo.insertions,
      deletions: commitInfo.deletions,
      aiInitiated,
      turnId: this.getLastTurnId() ?? undefined,
    };

    await this.postGitEvent(payload);
  }

  private async onBranchCreate(root: string, filePath: string): Promise<void> {
    const branch = this.branchFromRefPath(filePath);
    const payload: GitEventPayload = {
      type: "branch_create",
      branch,
      aiInitiated: false,
    };
    await this.postGitEvent(payload);
  }

  private async onRemoteChange(root: string, filePath: string): Promise<void> {
    const { remote, branch } = this.remoteBranchFromRefPath(filePath);

    // Get the new remote ref hash
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", `${remote}/${branch}`], { cwd: root });
      const hash = stdout.trim();
      const key = `${remote}/${branch}`;
      const prev = this.lastRemoteCommit.get(key);
      if (prev === hash) return;
      this.lastRemoteCommit.set(key, hash);
    } catch {
      // remote ref might not exist yet
    }

    const payload: GitEventPayload = {
      type: "push",
      branch,
      remote,
      aiInitiated: false,
      turnId: this.getLastTurnId() ?? undefined,
    };
    await this.postGitEvent(payload);
  }

  private async getLatestCommitInfo(root: string): Promise<{
    hash: string;
    message: string;
    author: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
  } | null> {
    try {
      const { stdout: logOut } = await execFileAsync(
        "git",
        ["log", "-1", "--format=%H|%s|%an"],
        { cwd: root },
      );
      const parts = logOut.trim().split("|");
      if (parts.length < 3) return null;
      const hash = parts[0]!;
      const message = parts[1]!;
      const author = parts[2]!;

      // Get diff stat
      let filesChanged = 0, insertions = 0, deletions = 0;
      try {
        const { stdout: statOut } = await execFileAsync(
          "git",
          ["diff", "--stat", "--numstat", "HEAD~1", "HEAD"],
          { cwd: root },
        );
        const lines = statOut.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const m = line.match(/^(\d+)\t(\d+)\t/);
          if (m) {
            filesChanged++;
            insertions += parseInt(m[1]!, 10);
            deletions += parseInt(m[2]!, 10);
          }
        }
      } catch {
        // first commit in repo, no HEAD~1
      }

      return { hash, message, author, filesChanged, insertions, deletions };
    } catch {
      return null;
    }
  }

  private async isAiInitiatedCommit(message: string): Promise<boolean> {
    // Check for common AI agent commit patterns
    const aiPatterns = [
      /co-authored-by:.*claude/i,
      /co-authored-by:.*anthropic/i,
      /co-authored-by:.*openai/i,
      /\[codex\]/i,
      /\[claude\]/i,
      /\[ai\]/i,
    ];
    return aiPatterns.some((p) => p.test(message));
  }

  private async postGitEvent(payload: GitEventPayload): Promise<void> {
    const sessionId = this.getSessionId();
    if (!sessionId) return;

    try {
      await this.api.request(`/sessions/${sessionId}/git-events`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      console.log(`[aidrift] git event posted: ${payload.type} ${payload.commitShort ?? payload.branch}`);
    } catch (err) {
      console.error("[aidrift] failed to post git event:", err);
    }
  }
}
