# AI Drift Detector

VSCode extension that watches your Claude Code and OpenAI Codex chats and warns when sessions drift — losing focus, repeating mistakes, or wasting your time.

## What it does

- Auto-detects new Claude Code transcripts
- Creates a drift session per chat tab and posts turns as they happen
- Live status bar showing the active profile; click it to switch profiles
- Notification with actions when drift is detected
- Sidebar list of recent sessions (AI Drift activity-bar view)
- Reports VSCode task and terminal outcomes (lint/build/test pass/fail) for the active turn
- Watches git for commits and pushes and attaches them to the session timeline

## Install

From VS Code:

1. Open the **Extensions** pane (`Cmd+Shift+X` / `Ctrl+Shift+X`).
2. Search for **AI Drift Detector** (publisher **GenioHub**).
3. Click **Install**.

Or from the command line:

```bash
code --install-extension GenioHub.aidrift
```

Marketplace page: <https://marketplace.visualstudio.com/items?itemName=GenioHub.aidrift>

## Setup

The extension connects to AiDrift at `https://drift.geniohub.com` by default. Sign up or sign in:

1. Click the **AI Drift** icon in the activity bar.
2. Click **Sign In** in the welcome view, or run `Drift: Sign In` from the Command Palette.
3. Pick **browser** sign-in for the zero-copy flow — the dashboard opens, you sign up or log in, and the token comes back to VS Code automatically. Or paste a PAT from the dashboard's **Generate Token** button.

The same sign-in works for the [companion CLI](https://github.com/geniohub/aidrift-cli) (`npm i -g @aidrift/cli`) and the [Claude Code plugin](https://github.com/geniohub/aidrift-plugin) — credentials are shared via `~/.drift/profiles.json`.

For local/self-hosted AiDrift backends, run `Drift: Add Profile` to register a second profile pointing at your backend URL (e.g. `http://localhost:3331/api`) and switch to it.

## Commands

All commands are available from the Command Palette (`Cmd+Shift+P`) under the `Drift:` prefix. Some are also surfaced from the status bar, the sidebar welcome view, and the walkthrough.

### Authentication

| Command | How to use |
| --- | --- |
| `Drift: Sign In` | Opens a quick-pick with three sign-in methods (browser / token / email+password). Pick one and follow the prompts. |
| `Drift: Sign In with Browser` | Opens the active profile's dashboard at `/cli-signin?callback=vscode://…`. After you log in or sign up, the dashboard redirects back and the token is stored automatically. |
| `Drift: Sign In with Token` | Prompts for a Personal Access Token (`aidrift_pat_…`) copied from the dashboard. Paste and confirm. |
| `Drift: Sign In with Email + Password` | Prompts for email, then password. Only works for accounts registered with a password. |
| `Drift: Sign Out` | Clears the stored token for the active profile, stops all watchers, and resets the status bar. |
| `Drift: Show Signed-In User` | Calls `/auth/me` and shows the current email + user id, or warns if the session expired. |

### Profiles (multi-host support)

A "profile" is a named `{apiBaseUrl, dashboardUrl}` pair with its own stored token. The active profile name is shown in the status bar; clicking it runs `Drift: Switch Profile`.

| Command | How to use |
| --- | --- |
| `Drift: Switch Profile` | Quick-pick of profiles; the active one has a check mark. Also includes `Add profile…` and `Edit profile…` shortcuts. Switching restarts the watchers against the new host. |
| `Drift: Add Profile` | Prompts for name (letters/digits/`_`/`-`), API base URL, and dashboard URL. Offers to switch to the new profile immediately. |
| `Drift: Edit Profile` | Pick a profile, then edit its name, API URL, and dashboard URL. |
| `Drift: Remove Profile` | Pick a non-active profile; confirms with a modal before deleting the profile and its stored credentials. Cannot remove the active profile — switch first. |
| `Drift: Show Current Profile` | Shows the active profile name, API URL, and signed-in email (or "not signed in"). |

### Session control

These operate on the currently tracked session (the most recent chat the watcher attached to).

| Command | How to use |
| --- | --- |
| `Drift: Show Status for Active Session` | Shows a notification with the last cached drift score, trend, task description, and any active alert reasons. |
| `Drift: Mark Last Turn Accepted` | Marks the most recent turn as accepted via `PATCH /turns/:id/outcome`. Feeds the acceptance-rate signal. |
| `Drift: Mark Last Turn Rejected` | Same as above but marks the turn rejected. |
| `Drift: Create Checkpoint for Active Session` | Prompts for a summary, then creates a manual checkpoint on the latest turn and records the current `git rev-parse HEAD` if available. |
| `Drift: Open Last Stable Checkpoint` | Opens the dashboard at the most recent checkpointed turn (anchor `#turn-…`). Warns if no stable checkpoint exists yet. |

### Dashboard + diagnostics

| Command | How to use |
| --- | --- |
| `Drift: Open Active Session in Dashboard` | Opens `{dashboardUrl}/sessions/{activeId}?workspacePath=…` in the system browser. Falls back to `/sessions` if no active session. |
| `Drift: Open Session in Dashboard` | Programmatic variant that takes a `sessionId` argument (used by the sidebar tree; not normally invoked by hand). |
| `Drift: Refresh Sessions` | Refreshes the sidebar tree. Also exposed as the refresh icon in the AI Drift view title. |
| `Drift: Debug Tracking` | Dumps watcher state, workspace root, active session id, and a call to `/tracking/health` into a new `AI Drift Tracking` output channel. Use when sessions aren't appearing. |

## UI surfaces

- **Activity bar view `AI Drift`** — tree of recent sessions. Auto-refreshes. Shows a welcome view with sign-in buttons when signed out.
- **Status bar item** — `$(pulse) aidrift: {profile}`. Click to switch profiles. Tooltip shows the API URL.
- **Walkthrough `Get Started with AI Drift`** — three steps: sign in, switch profiles, open the view. Available from the VSCode Walkthroughs page.
- **URI handler** — `vscode://geniohub.aidrift/signin-callback?token=…` is how the browser sign-in delivers the token back. `vscode://geniohub.aidrift/open-diff?...` opens a diff from the dashboard.

## Settings

- `aidrift.watchClaudeCode` (default `true`) — watch `~/.claude/projects/` for transcripts.
- `aidrift.watchCodex` (default `true`) — watch `~/.codex/sessions/` for rollouts.
- `aidrift.trackTaskExecution` (default `true`) — report VSCode task/terminal outcomes for the active turn. Terminal coverage requires shell integration (VSCode 1.93+).
- `aidrift.watchGitEvents` (default `true`) — watch `.git/refs/` for commits and pushes.
- `aidrift.statusPollIntervalSeconds` (default `30`) — poll interval for `/sessions/:id/status`. Backs off exponentially on failure, cap 5 min.
- `aidrift.requestTimeoutSeconds` (default `10`, min `2`) — HTTP timeout for extension → API calls.
- `aidrift.driftAlertThreshold` (default `65`) — score below which a drift alert fires.
- `aidrift.autoCheckpoint` (default `true`) — auto-checkpoint on every accepted turn.
- `aidrift.implicitAcceptTimeoutSeconds` (default `300`) — seconds without a follow-up before a turn is treated as implicitly accepted.
- `aidrift.apiBaseUrl`, `aidrift.dashboardUrl` — **deprecated**, ignored once profiles are configured. Use `Drift: Add Profile` / `Drift: Switch Profile` instead.
