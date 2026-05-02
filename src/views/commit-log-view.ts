import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readGitLog, type CommitRow } from "../git-log-reader";
import { CommitMetaCache } from "../commit-meta-cache";
import type { ApiClient, CommitMetaDto } from "../api-client";

const execFileAsync = promisify(execFile);

const DEFAULT_LIMIT = 100;
const CACHE_CAPACITY = 500;

type DriftState = "clean" | "drift" | "leak" | "untracked";

function classify(meta: CommitMetaDto | null): DriftState {
  if (!meta) return "untracked";
  // Phase 3 hasn't shipped yet; secret findings field will drop in later.
  // Leave the "leak" arm reserved for that wiring.
  const drift = meta.driftAtCommit;
  if (!drift) return "untracked";
  if (drift.score >= 80) return "clean";
  return "drift";
}

function iconFor(state: DriftState): vscode.ThemeIcon {
  switch (state) {
    case "clean":
      return new vscode.ThemeIcon(
        "circle-filled",
        new vscode.ThemeColor("charts.green"),
      );
    case "drift":
      return new vscode.ThemeIcon(
        "circle-filled",
        new vscode.ThemeColor("charts.yellow"),
      );
    case "leak":
      return new vscode.ThemeIcon(
        "circle-filled",
        new vscode.ThemeColor("charts.red"),
      );
    case "untracked":
      return new vscode.ThemeIcon("circle-outline");
  }
}

// Render a height-proportional tick string for the producing commit's
// activity. `filesChanged` from GitEvent is a stand-in for "size" — the
// spec says turn count, but the API doesn't surface that on CommitMetaDto
// yet. Cap visually at 5 ticks.
function turnTick(meta: CommitMetaDto | null): string {
  if (!meta) return "";
  const files = meta.event.filesChanged ?? 0;
  const ticks = Math.max(1, Math.min(5, Math.ceil(files / 3)));
  return "▍".repeat(ticks);
}

class CommitTreeItem extends vscode.TreeItem {
  constructor(
    public readonly row: CommitRow,
    public readonly meta: CommitMetaDto | null,
  ) {
    const state = classify(meta);
    const shortSha = row.sha.slice(0, 7);
    super(`${shortSha}  ${row.subject}`, vscode.TreeItemCollapsibleState.None);
    this.id = row.sha;
    this.iconPath = iconFor(state);

    const tick = turnTick(meta);
    const driftStr = meta?.driftAtCommit
      ? `${meta.driftAtCommit.score} ${trendArrow(meta.driftAtCommit.trend)}`
      : "—";
    const provider = meta?.session.provider ?? "";
    this.description = [tick, provider, driftStr].filter(Boolean).join("  ");

    this.tooltip = renderTooltip(row, meta, state);

    this.contextValue = state;

    if (meta) {
      this.command = {
        command: "aidrift.openSessionInDashboard",
        title: "Open session",
        arguments: [meta.session.id],
      };
    }
  }
}

function trendArrow(t: "improving" | "stable" | "drifting"): string {
  return t === "improving" ? "↑" : t === "drifting" ? "↓" : "→";
}

function renderTooltip(
  row: CommitRow,
  meta: CommitMetaDto | null,
  state: DriftState,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`**${row.subject}**\n\n`);
  md.appendMarkdown(`\`${row.sha.slice(0, 12)}\` · ${row.authorName} · ${new Date(row.committedAt).toLocaleString()}\n\n`);
  md.appendMarkdown(`drift state: **${state}**\n\n`);
  if (meta) {
    md.appendMarkdown(`session: ${meta.session.taskDescription}\n\n`);
    if (meta.driftAtCommit) {
      md.appendMarkdown(
        `score: ${meta.driftAtCommit.score} (${meta.driftAtCommit.trend})`,
      );
      if (meta.driftAtCommit.scopeDistance != null) {
        md.appendMarkdown(`  ·  scope distance: ${meta.driftAtCommit.scopeDistance.toFixed(2)}`);
      }
      md.appendMarkdown(`\n\n`);
      const fps = (meta.driftAtCommit.focalPoints ?? []).slice(0, 3);
      if (fps.length > 0) {
        md.appendMarkdown(`focal points: ${fps.map((f) => f.label).join(", ")}\n\n`);
      }
    }
    const args = encodeURIComponent(JSON.stringify([meta.session.id]));
    md.appendMarkdown(`[Open session in dashboard](command:aidrift.openSessionInDashboard?${args})`);
  } else {
    md.appendMarkdown(`_not produced inside an AiDrift session_`);
  }
  return md;
}

export class CommitLogTreeProvider implements vscode.TreeDataProvider<CommitTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly cache: CommitMetaCache<CommitMetaDto>;
  private readonly limit: number;

  constructor(
    private readonly api: ApiClient,
    private readonly workspaceRoots: () => string[],
    limit = DEFAULT_LIMIT,
  ) {
    this.limit = limit;
    this.cache = new CommitMetaCache<CommitMetaDto>(
      (sha) => this.api.getCommitBySha(sha),
      CACHE_CAPACITY,
    );
  }

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
  }

  refreshOne(sha: string): void {
    this.cache.invalidate(sha);
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CommitTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CommitTreeItem): Promise<CommitTreeItem[]> {
    if (element) return [];
    const root = this.workspaceRoots()[0];
    if (!root) return [];
    let rows: CommitRow[];
    try {
      const branch = await currentBranch(root);
      rows = await readGitLog(root, branch, this.limit);
    } catch {
      return [];
    }
    const items: CommitTreeItem[] = [];
    for (const row of rows) {
      let meta: CommitMetaDto | null = null;
      try {
        meta = await this.cache.get(row.sha);
      } catch {
        meta = null;
      }
      items.push(new CommitTreeItem(row, meta));
    }
    return items;
  }
}

async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return stdout.trim() || "HEAD";
}
