# Claw Studio — Architecture

This document captures the key architectural decisions for Claw Studio. Read this before making structural changes.

---

## What Claw Studio is

Claw Studio is an autonomous software factory. You point it at a GitHub repo with a ROADMAP.md and it implements the issues — one by one, milestone by milestone — using Claude Code agents.

There are two user-facing surfaces:

**Claw CLI** — terminal tool for developers and power users. Install globally, run from inside a project directory. Built with TypeScript and Ink.

**Claw Studio** (the app) — desktop dashboard for non-technical users. The chairman's interface. Built with Electron + React. Introduced in v0.2.

Both surfaces run the same core engine. The engine has no UI concerns.

---

## Source structure

```
src/
  core/       ← business logic, no UI, shared by CLI and app
    github/   ← ALL GitHub API calls
    roadmap/  ← ROADMAP.md parsing
    checks/   ← repo state inspector
    agents/   ← implementation agent, session management
    git/      ← git operations
    loop/     ← orchestrator
    types/    ← shared types, error definitions
  cli/        ← Claw CLI (Ink, terminal UI)
  app/        ← Claw Studio desktop app (Electron + React) — v0.2+
tests/
  core/       ← mirrors src/core/
  cli/        ← mirrors src/cli/
```

---

## Tech stack decisions

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript (strict) | One language throughout, agents know it well |
| Runtime | Node.js 20+ | ESM, stable, universal |
| GitHub API | `@octokit/rest` | Official library, auth strategy abstraction |
| Terminal UI | Ink | React for the terminal, used by Claude Code |
| Desktop app | Electron | TypeScript throughout, no Rust, code sharing with web |
| Tests | vitest | Fast, ESM-native, TypeScript-first |
| Process spawning | execa | Typed, Promise-based shell commands |
| Package manager | npm | Default, no surprises |

---

## GitHub auth abstraction

**All GitHub API calls go through `src/core/github/client.ts`.** No other module imports Octokit directly.

```typescript
// src/core/github/client.ts
export function createClient(): Octokit {
  const token = process.env.GITHUB_PAT
  if (!token) throw new ClawError("GITHUB_PAT is not set.")
  return new Octokit({ auth: token })
}
```

**v0.1:** PAT via `GITHUB_PAT` env variable.
**v0.3+:** GitHub App OAuth — user clicks "Connect GitHub", one-click install flow. Swap `authStrategy` in `createClient()`, nothing else changes.
**Self-hosted:** Device flow (`@octokit/auth-oauth-device`) — no client secret, works in CLI and desktop.

---

## File footprint in target repos

Claw Studio creates exactly these files in target repos:

```
.claw/
  CLAUDE.md         generated agent instructions for this project
  config.json       { repo, pollInterval, clawVersion }
  sessions/         one file per in-flight issue: { issueNumber, sessionId, fixAttempts }
.github/workflows/
  ci.yml            full pipeline: lint + typecheck + tests + review agents + merge gate
```

Claw Studio **reads but never modifies**:
```
README.md           must exist — hard requirement before setup runs
ROADMAP.md          user authors this — Claw Studio reads it every cycle
```

**Setup fails if any of the created files already exist**, unless `--overwrite` is passed.
Existing repo onboarding (understanding existing CI, existing code) is a later milestone.

---

## The `.claw/` directory

Everything Claw Studio owns lives in `.claw/`. This keeps the user's repo root clean.
The only exception is `.github/workflows/ci.yml` — GitHub requires this path.

```
.claw/CLAUDE.md     → passed to agents via --system-prompt
.claw/config.json   → repo, poll interval, version
.claw/sessions/     → implementation agent session IDs and fix attempt counts
```

---

## The review pipeline

Review agents run in GitHub Actions, not spawned by the loop. The loop opens a PR and waits. The agents fire automatically from `ci.yml`.

```
PR opened
    ↓
ci.yml triggers:
  lint + typecheck + tests (ubuntu-latest, in parallel)
    ↓
  get-context (self-hosted) — builds milestone context from ROADMAP
    ↓
  5 review agents in parallel (self-hosted):
    Arch — module structure, separation of concerns
    DX — TypeScript strictness, error quality, API intuitiveness
    Security — credential exposure, input validation (BLOCKING on any leak)
    Perf — unnecessary API calls, memory, blocking operations
    Test — missing tests, untested error paths, edge cases
    ↓
  Review Summary (self-hosted):
    posts verdict table
    exits 1 if any CHANGES REQUESTED → blocks merge
```

The loop monitors the PR for verdicts via the PR monitor (`src/core/checks/`).

---

## Merge gate

`Review Summary` is a required status check on the default branch. GitHub blocks merge until it passes. It only passes when all 5 agents approve.

---

## Session persistence

When an implementation agent starts, its session ID is stored in `.claw/sessions/{N}.json`:

```json
{
  "issueNumber": 7,
  "sessionId": "abc123",
  "fixAttempts": 0
}
```

When reviewers request changes, the same session resumes: `claude -p --resume {sessionId}`.
Fix attempts are tracked and incremented. After 3 attempts → `needs-human` label, session file deleted.

---

## CLI design

The `claw` binary is the Claw CLI. It runs from inside a project directory and reads `.claw/config.json` automatically.

```
claw setup [--repo owner/repo] [--overwrite]
claw start [--repo owner/repo] [--auto-continue] [--dry-run]
claw status [--repo owner/repo]
claw pause
claw resume
claw stop
claw logs [--tail] [--n 20]
claw help [command]
```

Repo detection order:
1. `--repo` flag if passed
2. `.claw/config.json` in current directory
3. `git remote get-url origin` — detect from local git remote
4. Error with clear message

---

## Operating modes

**Owner mode** (v0.1+): Claw Studio has admin access. Sets up the repo, owns the CI, manages branch protection. Full factory.

**Contributor mode** (v0.8): No admin access. Forks the repo, implements issues, opens PRs. The repo owner decides what to merge. Requires Claw Studio to run its own internal CI pipeline (built in v0.6) since it has no access to the target repo's GitHub Actions.

---

## What is NOT in v0.1

- `src/app/` — Electron app, v0.2
- GitHub App OAuth — v0.3
- Existing repo onboarding — later milestone
- AI-driven recovery suggestions — v0.5
- Contributor mode — v0.8
