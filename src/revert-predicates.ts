// Local evaluation of predicates 1, 2-client, 3, 4 from the Git Provenance
// "fits" set. The server fills in the other half (target SHA exists in
// recorded GitEvents, leaks at-or-before target, scope improves) — these
// four are the ones only the workspace's actual git state can answer.
//
// Convention: every predicate is `true` (pass), `false` (fail), or `null`
// (couldn't determine — usually because the git command errored). The UI
// treats `null` as a non-pass: the all-six-green gate requires `=== true`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export interface LocalPredicates {
  workingTreeClean: boolean | null;
  targetExists: boolean | null;
  noUnpushedBetween: boolean | null;
  noPushedBetween: boolean | null;
  // True iff `git rev-parse @{upstream}` resolved. When false, the gap
  // can't have any pushed commits — `noPushedBetween` is trivially true
  // and the suggested method is `reset --hard`.
  hasUpstream: boolean;
  // Non-fatal errors collected while running the four checks. Surfaced
  // to the user so a misleading "all green" doesn't hide a git failure.
  errors: string[];
}

export async function evaluateLocalPredicates(
  cwd: string,
  targetSha: string,
): Promise<LocalPredicates> {
  const errors: string[] = [];
  const collect = (label: string) => (e: unknown) => {
    errors.push(`${label}: ${(e as Error).message}`);
    return null;
  };

  const [clean, exists, gap] = await Promise.all([
    checkWorkingTreeClean(cwd).catch(collect("workingTreeClean")),
    checkTargetExists(cwd, targetSha).catch(collect("targetExists")),
    checkGap(cwd, targetSha).catch((e: unknown) => {
      errors.push(`gap: ${(e as Error).message}`);
      return { noUnpushed: null, noPushed: null, hasUpstream: false };
    }),
  ]);

  return {
    workingTreeClean: clean,
    targetExists: exists,
    noUnpushedBetween: gap.noUnpushed,
    noPushedBetween: gap.noPushed,
    hasUpstream: gap.hasUpstream,
    errors,
  };
}

async function checkWorkingTreeClean(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "-z"],
    { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
  );
  return stdout.length === 0;
}

async function checkTargetExists(cwd: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

async function checkGap(
  cwd: string,
  sha: string,
): Promise<{
  noUnpushed: boolean | null;
  noPushed: boolean | null;
  hasUpstream: boolean;
}> {
  const totalRes = await execFileAsync(
    "git",
    ["rev-list", "--count", `${sha}..HEAD`],
    { cwd, timeout: GIT_TIMEOUT_MS },
  );
  const total = parseInt(totalRes.stdout.trim(), 10);
  // HEAD is the target (or behind it) — nothing in the gap, both predicates
  // trivially pass. Caller will likely show "already at this commit".
  if (!Number.isFinite(total) || total === 0) {
    return { noUnpushed: true, noPushed: true, hasUpstream: false };
  }

  let hasUpstream = false;
  try {
    await execFileAsync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    hasUpstream = true;
  } catch {
    // No upstream — branch has never been pushed. The gap can't contain
    // pushed commits; everything in target..HEAD is local-only.
    return { noUnpushed: false, noPushed: true, hasUpstream: false };
  }

  const unpushedRes = await execFileAsync(
    "git",
    ["rev-list", "--count", `${sha}..HEAD`, "--not", "@{upstream}"],
    { cwd, timeout: GIT_TIMEOUT_MS },
  );
  const unpushed = parseInt(unpushedRes.stdout.trim(), 10);
  if (!Number.isFinite(unpushed)) {
    return { noUnpushed: null, noPushed: null, hasUpstream };
  }
  const pushed = total - unpushed;
  return {
    noUnpushed: unpushed === 0,
    noPushed: pushed === 0,
    hasUpstream,
  };
}

export async function getCurrentHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function stashWorkingTree(cwd: string, message: string): Promise<void> {
  await execFileAsync(
    "git",
    ["stash", "push", "-u", "-m", message],
    { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
  );
}

export async function resetHard(cwd: string, sha: string): Promise<void> {
  await execFileAsync("git", ["reset", "--hard", sha], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

export async function revertRange(cwd: string, fromSha: string): Promise<void> {
  // `git revert --no-edit <sha>..HEAD` creates one revert commit per commit
  // in the range, in reverse order. `--no-edit` keeps the default messages
  // so the operation is non-interactive.
  await execFileAsync(
    "git",
    ["revert", "--no-edit", `${fromSha}..HEAD`],
    { cwd, timeout: 30_000, maxBuffer: GIT_MAX_BUFFER },
  );
}
