// Extension HTTP client. Tokens live in vscode.SecretStorage (OS keychain).
// Auto-refreshes the access token on 401 and retries once.

import * as vscode from "vscode";

const ACCESS_KEY = "aidrift.accessToken";
const REFRESH_KEY = "aidrift.refreshToken";
const EMAIL_KEY = "aidrift.email";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
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

  async getEmail(): Promise<string | undefined> {
    return this.secrets.get(EMAIL_KEY);
  }

  async getAccess(): Promise<string | undefined> {
    return this.secrets.get(ACCESS_KEY);
  }

  async isSignedIn(): Promise<boolean> {
    return Boolean(await this.secrets.get(ACCESS_KEY));
  }

  async login(email: string, password: string): Promise<AuthResponse["user"]> {
    const res = await fetch(`${this.apiBaseUrl()}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
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
  }

  private async tryRefresh(): Promise<boolean> {
    const refreshToken = await this.secrets.get(REFRESH_KEY);
    if (!refreshToken) return false;
    const res = await fetch(`${this.apiBaseUrl()}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      await this.logout();
      return false;
    }
    const data = (await res.json()) as AuthResponse;
    await this.secrets.store(ACCESS_KEY, data.accessToken);
    await this.secrets.store(REFRESH_KEY, data.refreshToken);
    return true;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const access = await this.secrets.get(ACCESS_KEY);
    if (access) headers.set("Authorization", `Bearer ${access}`);

    let res = await fetch(`${this.apiBaseUrl()}${path}`, { ...init, headers });
    if (res.status === 401 && access) {
      const ok = await this.tryRefresh();
      if (ok) {
        const newAccess = await this.secrets.get(ACCESS_KEY);
        if (newAccess) headers.set("Authorization", `Bearer ${newAccess}`);
        res = await fetch(`${this.apiBaseUrl()}${path}`, { ...init, headers });
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
