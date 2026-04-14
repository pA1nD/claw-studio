# Claw Studio

**Claw your way.**

An autonomous software factory. Point it at a GitHub repo with a roadmap. Watch agents implement it — issue by issue, milestone by milestone.

---

## Two surfaces, one engine

**Claw CLI** — terminal tool for developers and power users. Install globally, run from inside a project directory.

**Claw Studio** (the app) — desktop dashboard for non-technical users. The chairman's interface. Electron app, v0.2+.

Both run the same core engine.

---

## How it works

```
You write a ROADMAP.md with milestones and GitHub issues

claw setup   → checks README + ROADMAP exist, creates .claw/, sets up CI, branch protection
claw start   → loop begins

Loop:
  read ROADMAP.md → identify current milestone → get next open issue
  inspect repo state → 13 ordered checks → halt on first problem
  spawn Claude Code agent → implement issue → open PR
  5 review agents fire in parallel (Arch, DX, Security, Perf, Test)
  all approved → squash merge → next issue
  any blocked  → same agent resumes (same session, no context loss) → fix → re-review
  3 failed attempts → label needs-human → skip, continue

Milestone complete → pause → notify → wait for confirmation → next milestone
```

---

## What Claw Studio creates in your repo

```
.claw/
  CLAUDE.md         generated agent instructions for your project
  config.json       settings
  sessions/         in-flight agent sessions
.github/workflows/
  ci.yml            CI pipeline + 5 parallel review agents + merge gate
```

It reads but never modifies `README.md` and `ROADMAP.md` — those are yours.

---

## Getting started

```bash
npm install -g claw-studio

cd your-project
claw setup        # detects repo from git remote, sets everything up
claw start        # loop begins
```

Requires:
- `GITHUB_PAT` — GitHub personal access token with `repo` and `workflow` scope
- `CLAUDE_CODE_OAUTH_TOKEN` — from `claude setup-token` (Claude Max subscription)
- Self-hosted runners registered to your repo
- `README.md` — must exist
- `ROADMAP.md` — must exist with at least one milestone

---

## CLI

```
claw setup  [--repo owner/repo] [--overwrite]   first-time setup
claw start  [--repo owner/repo] [--auto-continue] [--dry-run]
claw status [--repo owner/repo]                 current state
claw pause                                       pause after current action
claw resume                                      resume from paused
claw stop                                        stop cleanly
claw logs   [--tail] [--n 20]                   loop history
claw help   [command]
```

---

## Self-hosting

Claw Studio is MIT licensed. Run it yourself:

```bash
git clone https://github.com/pA1nD/claw-studio
cd claw-studio
npm install
npm run dev
```

For the GitHub connection, use the device flow:
```bash
GITHUB_AUTH_STRATEGY=device claw setup
```
No client secret required. Works in any terminal.

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full technical decisions — auth abstraction, file footprint, review pipeline, session persistence, CLI design, and the v0.8 contributor mode.

---

## Roadmap

See [ROADMAP.md](./ROADMAP.md).

| Milestone | What ships |
|---|---|
| v0.1 | The Loop — Claw CLI, core engine, runs on any repo |
| v0.2 | Single Project Dashboard — Electron app, live git graph |
| v0.3 | Mission Control — all projects at once |
| v0.4 | Drill Down — issue detail, agent timelines |
| v0.5 | The Idea Layer — describe idea, agents generate roadmap |
| v0.6 | The Executable — bundled app, no GitHub dependency |
| v0.7 | Collaboration — teams, roles, permissions |
| v0.8 | Living Software — auto-deploy, monitoring, contributor mode |

---

## The brand

**Claw** /klɔː/ — Old English *clawu*, to seize, to grip.

*Claw me, claw thee.* — agent starts work.
*Clawing at moonbeams.* — working.
*Clawed.* ✓ — milestone ships.
*Lost the claw.* — error.
*Back.* — fixed.

---

## License

MIT — Copyright 2026 Björn Schmidtke
