// Reads `git log` for a working-copy root and parses tab-separated output
// into structured rows. Splitting parsing from execFile lets us unit-test
// the parser without spawning git.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommitRow {
  sha: string;            // 40-char hex
  subject: string;        // first line of commit message
  committedAt: string;    // ISO-8601 (cI)
  authorName: string;
}

const PRETTY = "%H%x09%s%x09%cI%x09%an";

export async function readGitLog(
  cwd: string,
  ref: string,
  limit: number,
): Promise<CommitRow[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["log", `-n`, String(limit), `--pretty=format:${PRETTY}`, ref, "--"],
    { cwd, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseGitLog(stdout);
}

export function parseGitLog(stdout: string): CommitRow[] {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  const rows: CommitRow[] = [];
  for (const line of lines) {
    // Authoritative split: first separator at sha boundary, then subject
    // owns everything up to the LAST two separators (committedAt, authorName).
    const firstTab = line.indexOf("\t");
    const lastTab = line.lastIndexOf("\t");
    const secondLastTab = line.lastIndexOf("\t", lastTab - 1);
    if (firstTab < 0 || secondLastTab <= firstTab) continue;
    const sha = line.slice(0, firstTab);
    const subject = line.slice(firstTab + 1, secondLastTab);
    const committedAt = line.slice(secondLastTab + 1, lastTab);
    const authorName = line.slice(lastTab + 1);
    rows.push({ sha, subject, committedAt, authorName });
  }
  return rows;
}
