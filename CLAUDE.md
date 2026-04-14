# Claw Studio — Agent Instructions

You are building Claw Studio: an autonomous software factory that runs the development loop on any GitHub repo. Read ROADMAP.md and README.md before starting any work.

## Context files

@ROADMAP.md
@README.md

## What Claw Studio is

Two surfaces, one engine:

- **Claw CLI** (`src/cli/`) — terminal interface, power users, open source. Built with Ink.
- **Claw Studio app** (`src/app/`) — desktop dashboard, Electron, v0.2+. Not built yet.
- **Core engine** (`src/core/`) — shared by both. All business logic lives here.

In v0.1 we are building the core engine and the Claw CLI only. Do not build anything in `src/app/`.

## Project structure

    src/
      core/
        github/     GitHub API client (Octokit) — ALL GitHub calls go through here
        roadmap/    ROADMAP.md parser
        checks/     repo state inspector — one file per check
        agents/     implementation agent, session management
        git/        all git operations
        loop/       orchestrator
        types/      shared TypeScript types — errors, config, state
      cli/          Claw CLI — Ink components, command definitions
    tests/
      core/
        github/
        roadmap/
        checks/
        agents/
        git/
        loop/
      cli/

## Stack

- **TypeScript** — strict mode, no `any`, throughout the entire codebase
- **Node.js 20+**
- **`@octokit/rest`** — GitHub API client. The ONLY way to call GitHub. Never use raw fetch.
- **Ink** — terminal UI for Claw CLI. React components that render in the terminal.
- **`execa`** — spawning Claude Code CLI and shell commands
- **`vitest`** — all tests
- **Electron** — desktop app shell for v0.2+ (`src/app/`). Not used in v0.1.

## GitHub auth — critical

All GitHub API calls go through `src/core/github/client.ts`. Never import Octokit directly in other modules.

```typescript
// CORRECT — always do this
import { createClient } from "../core/github/client.ts"
const octokit = createClient()

// WRONG — never do this
import { Octokit } from "@octokit/rest"
```

This abstraction exists so the auth strategy (PAT now, GitHub App later) can be swapped in one place.

## File footprint in target repos

When Claw Studio sets up a target repo, it creates exactly these files:

```
.claw/
  CLAUDE.md         ← generated agent instructions for that project
  config.json       ← { repo, pollInterval, clawVersion }
  sessions/         ← { issueNumber, sessionId, fixAttempts } per in-flight issue
.github/workflows/
  ci.yml            ← lint + typecheck + tests + 5 review agents + summary
```

Plus it reads (never modifies):
```
README.md           ← required to exist before setup
ROADMAP.md          ← required to exist before setup
```

Never create or modify any other files in target repos.

## Coding standards

- Every public function has a JSDoc comment
- Errors are typed — define in `src/core/types/errors.ts`, never throw raw strings
- No `@ts-ignore` or `eslint-disable` — fix the actual problem
- Each module has its own test file in the matching `tests/` directory
- Functions are small and composable — if a function does two things, split it
- No side effects in check functions — checks are read-only

## Git rules

- Never commit directly to main
- Branch naming: `claw/issue-{N}-{slug}`
- Squash merge only
- Delete branch after merge
- Never force-push

## Error philosophy

All errors surface to the human — no silent failures. Error messages follow this format:

```
[CLAW] Stopped — {what is wrong}
{what to look at or do}
Run `claw status` to re-check once resolved.
```

The loop halts on first failed check. Never continue past an unknown state.

## Human steps convention

Issues may have a `## Human steps` section at the bottom. When present:

- **"do these BEFORE"** → walk the human through each step interactively before writing any code
- **"do these AFTER"** → implement first, walk through steps at the end

One step at a time. Validate each before proceeding. Plain English. No jargon.

## What to avoid

- Do not build anything in `src/app/` — that is v0.2
- Do not call GitHub API directly — always use `createClient()`
- Do not add features not in the current issue
- Do not refactor outside the scope of the current issue
- Do not skip tests
- Do not use `process.exit()` directly — use the typed error system
- Do not create or modify files in target repos beyond the defined footprint
