// Extension HTTP client. Tokens live in vscode.SecretStorage (OS keychain).
// Auto-refreshes the access token on 401 and retries once. Also refreshes
// proactively when the JWT is within REFRESH_AHEAD_MS of expiry so polling
// doesn't wedge on a token that's about to die.

import * as vscode from "vscode";

const ACCESS_KEY = "aidrift.accessToken";
const REFRESH_KEY = "aidrift.refreshToken";
const EMAIL_KEY = "aidrift.email";
const PAT_KEY = "aidrift.pat";

const PING_TIMEOUT_MS = 5_000;
// Refresh when the access token has less than this left.
const REFRESH_AHEAD_MS = 120_000;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class NetworkError extends Error {
  constructor(message: string, public override cause?: unknown) {
    super(message);
  }
}

function decodeJwtExpMs(token: string): number | null {
  const parts = token.split(".");
  const payloadSegment = parts[1];
  if (!payloadSegment) return null;
  try {
    const payload = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const obj = JSON.parse(payload) as { exp?: unknown };
    return typeof obj.exp === "number" ? obj.exp * 1000 : null;
  } catch {
    return null;
  }
}

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; createdAt: string };
}

export class ApiClient {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private apiBaseUrl(): string {
    return vscode.workspace.getConfiguration("aidrift").get<string>("apiBaseUrl")
      ?? "http://localhost:3330";
  }

  private requestTimeoutMs(): number {
    const sec = vscode.workspace
      .getConfiguration("aidrift")
      .get<number>("requestTimeoutSeconds", 10);
    return Math.max(2, sec) * 1000;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new NetworkError(`request timed out after ${timeoutMs}ms`, err);
      }
      throw new NetworkError((err as Error).message, err);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Unauthenticated liveness probe against /healthz. Used by the status
   * poller to distinguish "API unreachable" from "signed out" or
   * "no recent activity".
   */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(
        `${this.apiBaseUrl()}/healthz`,
        { method: "GET" },
        PING_TIMEOUT_MS,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async getEmail(): Promise<string | undefined> {
    return this.secrets.get(EMAIL_KEY);
  }

  async getAccess(): Promise<string | undefined> {
    return this.secrets.get(ACCESS_KEY);
  }

  async isSignedIn(): Promise<boolean> {
    return Boolean((await this.secrets.get(PAT_KEY)) || (await this.secrets.get(ACCESS_KEY)));
  }

  /**
   * Sign in with a Personal Access Token minted from the dashboard. Probes
   * /auth/me to confirm the token is valid before persisting.
   */
  async loginWithToken(token: string): Promise<AuthResponse["user"]> {
    const res = await this.fetchWithTimeout(
      `${this.apiBaseUrl()}/auth/me`,
      { headers: { Authorization: `Bearer ${token}` } },
      this.requestTimeoutMs(),
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new ApiError(res.status, body.error ?? res.statusText);
    }
    const user = (await res.json()) as AuthResponse["user"];
    await this.secrets.store(PAT_KEY, token);
    await this.secrets.store(EMAIL_KEY, user.email);
    // Token-based login is exclusive: clear any stale JWT pair so request()
    // doesn't accidentally fall back to expired credentials.
    await this.secrets.delete(ACCESS_KEY);
    await this.secrets.delete(REFRESH_KEY);
    return user;
  }

  async login(email: string, password: string): Promise<AuthResponse["user"]> {
    const res = await this.fetchWithTimeout(
      `${this.apiBaseUrl()}/auth/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      },
      this.requestTimeoutMs(),
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new ApiError(res.status, body.error ?? res.statusText);
    }
    const data = (await res.json()) as AuthResponse;
    await this.secrets.store(ACCESS_KEY, data.accessToken);
    await this.secrets.store(REFRESH_KEY, data.refreshToken);
    await this.secrets.store(EMAIL_KEY, data.user.email);
    return data.user;
  }

  async logout(): Promise<void> {
    await this.secrets.delete(ACCESS_KEY);
    await this.secrets.delete(REFRESH_KEY);
    await this.secrets.delete(EMAIL_KEY);
    await this.secrets.delete(PAT_KEY);
  }

  /**
   * Exchange the refresh token for a new access/refresh pair.
   *
   * `logoutOnFailure` should only be true on the reactive path (after a
   * 401 confirmed the access token is dead). On the proactive path the
   * current access token may still be valid for another ~2 minutes, so a
   * transient refresh failure (network blip, server restart) should not
   * kick the user out.
   */
  private async tryRefresh(logoutOnFailure: boolean): Promise<boolean> {
    const refreshToken = await this.secrets.get(REFRESH_KEY);
    if (!refreshToken) return false;
    try {
      const res = await this.fetchWithTimeout(
        `${this.apiBaseUrl()}/auth/refresh`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        },
        this.requestTimeoutMs(),
      );
      if (!res.ok) {
        if (logoutOnFailure) await this.logout();
        return false;
      }
      const data = (await res.json()) as AuthResponse;
      await this.secrets.store(ACCESS_KEY, data.accessToken);
      await this.secrets.store(REFRESH_KEY, data.refreshToken);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Refresh the access token if it's within REFRESH_AHEAD_MS of expiring.
   * Best-effort: failures are swallowed; the caller will still send the
   * request and fall back to the reactive 401 path if it really is dead.
   */
  private async refreshIfExpiringSoon(): Promise<void> {
    const access = await this.secrets.get(ACCESS_KEY);
    if (!access) return;
    const expMs = decodeJwtExpMs(access);
    if (!expMs) return;
    if (expMs - Date.now() > REFRESH_AHEAD_MS) return;
    await this.tryRefresh(false);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const pat = await this.secrets.get(PAT_KEY);
    if (!pat) await this.refreshIfExpiringSoon();
    const access = pat ?? (await this.secrets.get(ACCESS_KEY));
    if (access) headers.set("Authorization", `Bearer ${access}`);

    const timeoutMs = this.requestTimeoutMs();
    let res = await this.fetchWithTimeout(
      `${this.apiBaseUrl()}${path}`,
      { ...init, headers },
      timeoutMs,
    );
    // PATs don't refresh — on 401 we just surface the error so the user
    // can re-paste a token. Only the JWT path attempts auto-refresh.
    if (res.status === 401 && !pat && access) {
      const ok = await this.tryRefresh(true);
      if (ok) {
        const newAccess = await this.secrets.get(ACCESS_KEY);
        if (newAccess) headers.set("Authorization", `Bearer ${newAccess}`);
        res = await this.fetchWithTimeout(
          `${this.apiBaseUrl()}${path}`,
          { ...init, headers },
          timeoutMs,
        );
      }
    }

    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch { /* ignore */ }
      throw new ApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
