import * as vscode from "vscode";

// Structured logger that writes to a dedicated "AI Drift" output channel,
// visible via View → Output → "AI Drift". Anything the extension does
// after activation should flow through here rather than console.log so
// users can diagnose behavior without opening Code's dev tools.

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  show(): void;
  dispose(): void;
}

export function createOutputLogger(): Logger {
  const channel = vscode.window.createOutputChannel("AI Drift");
  const emit = (level: string, msg: string, data?: Record<string, unknown>) => {
    const hms = new Date().toISOString().slice(11, 23);
    const suffix =
      data && Object.keys(data).length > 0 ? " " + safeStringify(data) : "";
    channel.appendLine(`${hms} ${level} ${msg}${suffix}`);
  };
  return {
    info: (m, d) => emit("INFO ", m, d),
    warn: (m, d) => emit("WARN ", m, d),
    error: (m, d) => emit("ERROR", m, d),
    show: () => channel.show(true),
    dispose: () => channel.dispose(),
  };
}

function safeStringify(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    return "[unserializable]";
  }
}
