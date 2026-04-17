// Observes workspace tasks AND raw terminal shell executions (via the
// Shell Integration API, feature-detected so we stay compatible with
// older VSCode hosts) and reports lint/build/test pass/fail to the API
// so the Code Quality dashboard has data without manual instrumentation.
// Attributes each outcome to the latest turn of the active session.

import * as vscode from "vscode";
import type { ApiClient } from "./api-client";
import type { SessionManager } from "./session-manager";

type Stage = "lint" | "build" | "test" | "runtime";
type Source = "task" | "terminal";

const LINT_RE = /\b(lint|eslint|prettier|stylelint|biome)\b/;
const TEST_RE = /\b(test|vitest|jest|mocha|pytest|spec|cypress|playwright)\b/;
const BUILD_RE = /\b(build|compile|bundle|tsc|typecheck|type-check|webpack|vite|next|esbuild|rollup|turbo)\b/;

function classifyFromText(text: string): Stage | null {
  const haystack = text.toLowerCase();
  if (LINT_RE.test(haystack)) return "lint";
  if (TEST_RE.test(haystack)) return "test";
  if (BUILD_RE.test(haystack)) return "build";
  return null;
}

function classifyStage(task: vscode.Task): Stage | null {
  const def = task.definition as Record<string, unknown>;
  return classifyFromText(
    [
      task.name ?? "",
      typeof def.script === "string" ? def.script : "",
      typeof def.label === "string" ? def.label : "",
      typeof def.command === "string" ? def.command : "",
    ].join(" "),
  );
}

export class TaskWatcher {
  private readonly disposables: vscode.Disposable[] = [];
  // Keyed by TaskExecution reference — the same object is passed to
  // onDidStart/onDidEnd, and the End event doesn't expose a processId.
  private readonly taskInflight = new WeakMap<vscode.TaskExecution, { stage: Stage; startedAt: number }>();
  private readonly terminalInflight = new WeakMap<object, { stage: Stage; startedAt: number }>();
  // Count of VSCode tasks currently running. Recent VSCode versions surface
  // task shells through shell integration too, so we suppress terminal events
  // while a task is inflight to avoid double-counting the same run.
  private taskInflightCount = 0;

  constructor(
    private readonly api: ApiClient,
    private readonly sessionManager: SessionManager,
  ) {}

  start(): void {
    this.disposables.push(
      vscode.tasks.onDidStartTaskProcess((e) => this.onTaskStart(e)),
      vscode.tasks.onDidEndTaskProcess((e) => void this.onTaskEnd(e)),
    );

    // Shell Integration API — stable in VSCode 1.93+. Feature-detect so older
    // hosts still get the task-based path without crashing the extension.
    const win = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: vscode.Event<{ execution: { commandLine: { value: string } } }>;
      onDidEndTerminalShellExecution?: vscode.Event<{
        execution: { commandLine: { value: string } };
        exitCode: number | undefined;
      }>;
    };
    if (win.onDidStartTerminalShellExecution && win.onDidEndTerminalShellExecution) {
      this.disposables.push(
        win.onDidStartTerminalShellExecution((e) => this.onTerminalStart(e)),
        win.onDidEndTerminalShellExecution((e) => void this.onTerminalEnd(e)),
      );
    }
  }

  stop(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private onTaskStart(e: vscode.TaskProcessStartEvent): void {
    this.taskInflightCount++;
    const stage = classifyStage(e.execution.task);
    if (!stage) return;
    this.taskInflight.set(e.execution, { stage, startedAt: Date.now() });
  }

  private async onTaskEnd(e: vscode.TaskProcessEndEvent): Promise<void> {
    this.taskInflightCount = Math.max(0, this.taskInflightCount - 1);
    const entry = this.taskInflight.get(e.execution);
    if (!entry) return;
    this.taskInflight.delete(e.execution);
    await this.record(entry.stage, e.exitCode, entry.startedAt, "task");
  }

  private onTerminalStart(e: { execution: { commandLine: { value: string } } }): void {
    if (this.taskInflightCount > 0) return;
    const cmd = e.execution.commandLine?.value;
    if (!cmd) return;
    const stage = classifyFromText(cmd);
    if (!stage) return;
    this.terminalInflight.set(e.execution as unknown as object, { stage, startedAt: Date.now() });
  }

  private async onTerminalEnd(e: {
    execution: { commandLine: { value: string } };
    exitCode: number | undefined;
  }): Promise<void> {
    const key = e.execution as unknown as object;
    const entry = this.terminalInflight.get(key);
    if (!entry) return;
    this.terminalInflight.delete(key);
    // exitCode can be undefined when the shell couldn't report one (e.g. user
    // killed the terminal). Skip those rather than guessing a status.
    if (typeof e.exitCode !== "number") return;
    await this.record(entry.stage, e.exitCode, entry.startedAt, "terminal");
  }

  private async record(
    stage: Stage,
    exitCode: number | undefined,
    startedAt: number,
    source: Source,
  ): Promise<void> {
    const sessionId = this.sessionManager.getActiveSessionId();
    if (!sessionId) return;

    let turnId: string | null = null;
    try {
      const turns = await this.api.request<Array<{ id: string; turnIndex: number }>>(
        `/sessions/${sessionId}/turns`,
      );
      turnId = turns.at(-1)?.id ?? null;
    } catch (err) {
      console.error(`[aidrift] task-watcher(${source}): listing turns failed:`, err);
      return;
    }
    if (!turnId) return;

    const status = exitCode === 0 ? "pass" : "fail";
    const durationMs = Math.max(0, Date.now() - startedAt);

    try {
      await this.api.request(`/turns/${turnId}/execution`, {
        method: "PATCH",
        body: JSON.stringify({
          stage,
          status,
          durationMs,
          errorType: status === "fail" ? `${stage}_failed_via_${source}` : undefined,
        }),
      });
    } catch (err) {
      console.error(`[aidrift] task-watcher(${source}): recording execution failed:`, err);
    }
  }
}
