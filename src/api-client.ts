// Extension HTTP client. Tokens live in vscode.SecretStorage (OS keychain),
// scoped per profile (`aidrift.profile.<name>.*`). Active host + credentials
// come from the ProfileManager. Auto-refreshes access tokens on 401 and
// proactively if they're within REFRESH_AHEAD_MS of expiry so polling
// doesn't wedge on a dying token.

import * as vscode from "vscode";
import type { ProfileManager } from "./profile-manager";

const PING_TIMEOUT_MS = 5_000;
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
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly profiles: ProfileManager,
  ) {}

  private key(kind: "accessToken" | "refreshToken" | "email" | "pat"): string {
    return `aidrift.profile.${this.profiles.getActiveName()}.${kind}`;
  }

  private apiBaseUrl(): string {
    return this.profiles.getApiBaseUrl();
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
    return this.secrets.get(this.key("email"));
  }

  async getAccess(): Promise<string | undefined> {
    return this.secrets.get(this.key("accessToken"));
  }

  async isSignedIn(): Promise<boolean> {
    return Boolean(
      (await this.secrets.get(this.key("pat"))) ||
        (await this.secrets.get(this.key("accessToken"))),
    );
  }

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
    await this.secrets.store(this.key("pat"), token);
    await this.secrets.store(this.key("email"), user.email);
    await this.secrets.delete(this.key("accessToken"));
    await this.secrets.delete(this.key("refreshToken"));
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
    await this.secrets.store(this.key("accessToken"), data.accessToken);
    await this.secrets.store(this.key("refreshToken"), data.refreshToken);
    await this.secrets.store(this.key("email"), data.user.email);
    await this.secrets.delete(this.key("pat"));
    return data.user;
  }

  async logout(): Promise<void> {
    const pat = await this.secrets.get(this.key("pat"));
    if (pat) {
      // Best-effort: revoke server-side so stale tokens don't pile up in
      // /settings/tokens. If offline or the server rejects, still sign out
      // locally — the user asked to log out.
      try {
        await this.fetchWithTimeout(
          `${this.apiBaseUrl()}/auth/pats/current`,
          { method: "DELETE", headers: { Authorization: `Bearer ${pat}` } },
          this.requestTimeoutMs(),
        );
      } catch {
        // swallow
      }
    }
    await this.secrets.delete(this.key("accessToken"));
    await this.secrets.delete(this.key("refreshToken"));
    await this.secrets.delete(this.key("email"));
    await this.secrets.delete(this.key("pat"));
  }

  private async tryRefresh(logoutOnFailure: boolean): Promise<boolean> {
    const refreshToken = await this.secrets.get(this.key("refreshToken"));
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
      await this.secrets.store(this.key("accessToken"), data.accessToken);
      await this.secrets.store(this.key("refreshToken"), data.refreshToken);
      return true;
    } catch {
      return false;
    }
  }

  private async refreshIfExpiringSoon(): Promise<void> {
    const access = await this.secrets.get(this.key("accessToken"));
    if (!access) return;
    const expMs = decodeJwtExpMs(access);
    if (!expMs) return;
    if (expMs - Date.now() > REFRESH_AHEAD_MS) return;
    await this.tryRefresh(false);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const pat = await this.secrets.get(this.key("pat"));
    if (!pat) await this.refreshIfExpiringSoon();
    const access = pat ?? (await this.secrets.get(this.key("accessToken")));
    if (access) headers.set("Authorization", `Bearer ${access}`);

    const timeoutMs = this.requestTimeoutMs();
    let res = await this.fetchWithTimeout(
      `${this.apiBaseUrl()}${path}`,
      { ...init, headers },
      timeoutMs,
    );
    if (res.status === 401 && !pat && access) {
      const ok = await this.tryRefresh(true);
      if (ok) {
        const newAccess = await this.secrets.get(this.key("accessToken"));
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
