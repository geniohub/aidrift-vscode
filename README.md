# AI Drift Detector

VSCode extension that watches your Claude Code and OpenAI Codex chats and warns when sessions drift — losing focus, repeating mistakes, or wasting your time.

## What it does

- Auto-detects new Claude Code transcripts at `~/.claude/projects/**/*.jsonl` and Codex rollouts at `~/.codex/sessions/**/rollout-*.jsonl`
- Creates a drift session per chat tab and posts turns as they happen
- Live status bar showing score (0–100) and trend (↗ / → / ↘)
- Notification with actions when drift is detected
- Sidebar list of recent sessions

## Setup

Requires an AI Drift backend running. For local dev: clone the repo, `docker compose up -d`, set `aidrift.apiBaseUrl` to your deployment (defaults to `http://localhost:3331/api`), and sign in via `Drift: Sign In`.

## Commands

- `Drift: Sign In` / `Drift: Sign Out` / `Drift: Show Signed-In User`
- `Drift: Show Status for Active Session`
- `Drift: Open Active Session in Dashboard`
- `Drift: Mark Last Turn Accepted` / `Drift: Mark Last Turn Rejected`
- `Drift: Create Checkpoint for Active Session`

## Settings

- `aidrift.apiBaseUrl` — AI Drift API base URL (default `http://localhost:3331/api`)
- `aidrift.dashboardUrl` — dashboard base URL (default `http://localhost:3331`)
- `aidrift.watchClaudeCode` — enable Claude Code transcript watcher (default `true`)
- `aidrift.watchCodex` — enable OpenAI Codex rollout watcher (default `true`)
- `aidrift.statusPollIntervalSeconds` — poll interval for status bar (default `3`)
