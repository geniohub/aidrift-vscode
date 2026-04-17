// Browser-based sign-in flow.
//
//   1. `startSignIn()` generates a random `state`, stores it, and opens the
//      dashboard's /connect/vscode?state=… page in the browser.
//   2. The user logs in/signs up on the dashboard if needed.
//   3. The dashboard mints a PAT, then redirects the browser to
//      vscode://aidrift.aidrift/callback?token=…&state=…
//   4. `handleCallback()` verifies the state matches the one we generated,
//      then stores the token against the active profile via ApiClient.

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { ApiClient } from "./api-client";
import type { ProfileManager } from "./profile-manager";

const PENDING_KEY = "aidrift.signIn.pendingState.v1";
const STATE_TTL_MS = 10 * 60_000;

interface PendingState {
  state: string;
  profileName: string;
  createdAt: number;
}

function generateState(): string {
  return randomBytes(24).toString("base64url");
}

function connectUrl(dashboardUrl: string, state: string): string {
  const base = dashboardUrl.replace(/\/$/, "");
  const params = new URLSearchParams({ state, client: "VSCode" });
  return `${base}/connect/vscode?${params.toString()}`;
}

export class BrowserSignIn {
  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly apiClient: ApiClient,
    private readonly profiles: ProfileManager,
    private readonly onAuthenticated: () => Promise<void> | void,
  ) {}

  async startSignIn(): Promise<void> {
    const profileName = this.profiles.getActiveName();
    const dashboardUrl = this.profiles.getDashboardUrl();
    const state = generateState();
    const pending: PendingState = {
      state,
      profileName,
      createdAt: Date.now(),
    };
    await this.ctx.globalState.update(PENDING_KEY, pending);

    const url = connectUrl(dashboardUrl, state);
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
    if (!opened) {
      void vscode.window.showErrorMessage(
        `AI Drift: couldn't open browser. Visit ${url} manually.`,
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `AI Drift: finish sign-in in your browser (profile: ${profileName}).`,
    );
  }

  /**
   * Handle vscode://aidrift.aidrift/callback?token=…&state=…
   *
   * Validates the state against the one we generated, stores the token
   * against the profile that was active when the flow started.
   */
  async handleCallback(query: URLSearchParams): Promise<void> {
    const token = query.get("token");
    const state = query.get("state");
    if (!token || !state) {
      void vscode.window.showErrorMessage(
        "AI Drift: sign-in callback was missing token or state.",
      );
      return;
    }

    const pending = this.ctx.globalState.get<PendingState>(PENDING_KEY);
    await this.ctx.globalState.update(PENDING_KEY, undefined);

    if (!pending) {
      void vscode.window.showErrorMessage(
        "AI Drift: received a sign-in callback but no pending sign-in was in flight. Ignoring.",
      );
      return;
    }
    if (pending.state !== state) {
      void vscode.window.showErrorMessage(
        "AI Drift: sign-in state mismatch. Start the sign-in again from the command palette.",
      );
      return;
    }
    if (Date.now() - pending.createdAt > STATE_TTL_MS) {
      void vscode.window.showErrorMessage(
        "AI Drift: sign-in link expired (10 minute limit). Start over.",
      );
      return;
    }

    // Switch to the profile that was active when the sign-in started, so
    // the token lands against the right host even if the user changed the
    // active profile in the meantime.
    if (this.profiles.getActiveName() !== pending.profileName) {
      try {
        await this.profiles.setActive(pending.profileName);
      } catch {
        // Profile removed while signing in — surface clear error instead of
        // silently writing the token to the wrong profile.
        void vscode.window.showErrorMessage(
          `AI Drift: profile "${pending.profileName}" no longer exists. Sign in again.`,
        );
        return;
      }
    }

    try {
      const user = await this.apiClient.loginWithToken(token.trim());
      void vscode.window.showInformationMessage(
        `Signed in to AI Drift as ${user.email} (profile: ${pending.profileName}).`,
      );
      await this.onAuthenticated();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `AI Drift: sign-in failed: ${(err as Error).message}`,
      );
    }
  }
}
