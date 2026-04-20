// Detects post-rewrite (filter-branch, filter-repo, rebase) SHAs by asking the
// server to reconcile recorded GitEvent.commitHash values against the workspace's
// current HEAD. The server matches by commit subject when unique on HEAD.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ApiClient } from "./api-client";

const execFileAsync = promisify(execFile);

interface ReconcileResult {
  rewritten: number;
  scanned: number;
}

export async function reconcileGitCommits(
  api: ApiClient,
  workspacePath: string,
  maxCommits = 500,
): Promise<ReconcileResult | null> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "git",
      ["log", `-n${maxCommits}`, "HEAD", "--pretty=format:%H%x09%s"],
      { cwd: workspacePath, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch {
    return null;
  }

  const commits: Array<{ sha: string; subject: string }> = [];
  for (const raw of stdout.split("\n")) {
    const tab = raw.indexOf("\t");
    if (tab <= 0) continue;
    const sha = raw.slice(0, tab);
    const subject = raw.slice(tab + 1);
    if (/^[0-9a-f]{40}$/.test(sha) && subject.length > 0) {
      commits.push({ sha, subject });
    }
  }
  if (commits.length === 0) return null;

  try {
    return await api.request<ReconcileResult>("/git-events/reconcile", {
      method: "POST",
      body: JSON.stringify({ workspacePath, commits }),
    });
  } catch {
    return null;
  }
}
