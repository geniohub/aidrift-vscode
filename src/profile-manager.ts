// Named profiles for the extension. Each profile has its own API host and
// its own credentials (kept in SecretStorage under a profile-scoped prefix).
// globalState holds the profile list + the active profile name so they
// persist across workspaces.

import * as vscode from "vscode";

export interface ProfileConfig {
  apiBaseUrl: string;
  dashboardUrl?: string;
}

interface ProfilesState {
  active: string;
  profiles: Record<string, ProfileConfig>;
}

const STATE_KEY = "aidrift.profiles.v1";

// Seeded on first run. Matches the default prod deployment.
export const DEFAULT_PROFILE_NAME = "default";
export const DEFAULT_API_URL = "https://drift.geniohub.com/api";
export const DEFAULT_DASHBOARD_URL = "https://drift.geniohub.com";

function defaultState(): ProfilesState {
  return {
    active: DEFAULT_PROFILE_NAME,
    profiles: {
      [DEFAULT_PROFILE_NAME]: {
        apiBaseUrl: DEFAULT_API_URL,
        dashboardUrl: DEFAULT_DASHBOARD_URL,
      },
    },
  };
}

/**
 * Pull any one-time migration inputs from the legacy (unscoped) settings
 * and secrets into a fresh profile named "legacy" — so a user upgrading
 * from pre-profiles doesn't silently lose their signed-in session.
 */
async function migrateLegacyInto(
  state: ProfilesState,
  ctx: vscode.ExtensionContext,
): Promise<ProfilesState> {
  const cfg = vscode.workspace.getConfiguration("aidrift");
  const legacyApi = cfg.get<string>("apiBaseUrl");
  const legacyDash = cfg.get<string>("dashboardUrl");
  const hasLegacySecrets =
    (await ctx.secrets.get("aidrift.accessToken")) ||
    (await ctx.secrets.get("aidrift.pat"));

  // Only treat it as a meaningful legacy setup if the user had either
  // non-default host or actual credentials stored.
  const hasInterestingApi = legacyApi && legacyApi !== DEFAULT_API_URL
    && legacyApi !== "http://localhost:3331/api"
    && legacyApi !== "http://localhost:3330";
  if (!hasLegacySecrets && !hasInterestingApi) return state;

  if (!state.profiles["legacy"]) {
    state.profiles["legacy"] = {
      apiBaseUrl: legacyApi ?? DEFAULT_API_URL,
      dashboardUrl: legacyDash ?? DEFAULT_DASHBOARD_URL,
    };
    // Move legacy secrets over to the "legacy"-scoped keys so the new
    // ApiClient can pick them up.
    for (const key of ["accessToken", "refreshToken", "email", "pat"]) {
      const val = await ctx.secrets.get(`aidrift.${key}`);
      if (val) {
        await ctx.secrets.store(`aidrift.profile.legacy.${key}`, val);
      }
    }
    state.active = "legacy";
  }
  return state;
}

export class ProfileManager {
  private state: ProfilesState = defaultState();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async init(): Promise<void> {
    const stored = this.ctx.globalState.get<ProfilesState>(STATE_KEY);
    if (stored && stored.profiles && stored.active) {
      this.state = stored;
    } else {
      this.state = await migrateLegacyInto(defaultState(), this.ctx);
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.globalState.update(STATE_KEY, this.state);
  }

  getActiveName(): string {
    return this.state.active;
  }

  getActive(): ProfileConfig {
    return this.state.profiles[this.state.active] ?? {
      apiBaseUrl: DEFAULT_API_URL,
      dashboardUrl: DEFAULT_DASHBOARD_URL,
    };
  }

  getApiBaseUrl(): string {
    return this.getActive().apiBaseUrl ?? DEFAULT_API_URL;
  }

  getDashboardUrl(): string {
    return this.getActive().dashboardUrl ?? DEFAULT_DASHBOARD_URL;
  }

  list(): Array<{ name: string; config: ProfileConfig; active: boolean }> {
    return Object.entries(this.state.profiles).map(([name, config]) => ({
      name,
      config,
      active: name === this.state.active,
    }));
  }

  async add(name: string, config: ProfileConfig): Promise<void> {
    if (!name || /[^a-zA-Z0-9_-]/.test(name)) {
      throw new Error(`invalid profile name "${name}" (use letters, digits, _ or -)`);
    }
    if (this.state.profiles[name]) {
      throw new Error(`profile "${name}" already exists`);
    }
    this.state.profiles[name] = config;
    await this.persist();
  }

  async remove(name: string): Promise<void> {
    if (!this.state.profiles[name]) throw new Error(`no profile named "${name}"`);
    delete this.state.profiles[name];
    if (Object.keys(this.state.profiles).length === 0) {
      this.state = defaultState();
    } else if (this.state.active === name) {
      this.state.active = Object.keys(this.state.profiles)[0]!;
    }
    // Wipe this profile's secrets too.
    for (const key of ["accessToken", "refreshToken", "email", "pat"]) {
      await this.ctx.secrets.delete(`aidrift.profile.${name}.${key}`);
    }
    await this.persist();
    this.onDidChangeEmitter.fire(this.state.active);
  }

  async setActive(name: string): Promise<void> {
    if (!this.state.profiles[name]) throw new Error(`no profile named "${name}"`);
    if (this.state.active === name) return;
    this.state.active = name;
    await this.persist();
    this.onDidChangeEmitter.fire(name);
  }

  async update(name: string, patch: Partial<ProfileConfig>): Promise<void> {
    const existing = this.state.profiles[name];
    if (!existing) throw new Error(`no profile named "${name}"`);
    this.state.profiles[name] = { ...existing, ...patch };
    await this.persist();
    if (name === this.state.active) this.onDidChangeEmitter.fire(name);
  }

  async rename(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    if (!newName || /[^a-zA-Z0-9_-]/.test(newName)) {
      throw new Error(`invalid profile name "${newName}" (use letters, digits, _ or -)`);
    }
    const existing = this.state.profiles[oldName];
    if (!existing) throw new Error(`no profile named "${oldName}"`);
    if (this.state.profiles[newName]) {
      throw new Error(`profile "${newName}" already exists`);
    }

    this.state.profiles[newName] = existing;
    delete this.state.profiles[oldName];
    if (this.state.active === oldName) this.state.active = newName;

    // Move secrets: aidrift.profile.<oldName>.* → aidrift.profile.<newName>.*
    for (const kind of ["accessToken", "refreshToken", "email", "pat"]) {
      const oldKey = `aidrift.profile.${oldName}.${kind}`;
      const newKey = `aidrift.profile.${newName}.${kind}`;
      const val = await this.ctx.secrets.get(oldKey);
      if (val !== undefined) {
        await this.ctx.secrets.store(newKey, val);
        await this.ctx.secrets.delete(oldKey);
      }
    }

    await this.persist();
    this.onDidChangeEmitter.fire(this.state.active);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
