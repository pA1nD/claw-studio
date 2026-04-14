# Contributing to Claw Studio

Claw Studio is MIT licensed and self-hostable. This guide covers how to run it locally, how to contribute, and how the self-hosted path works.

---

## Prerequisites

- Node.js 20+
- npm
- A GitHub account with a PAT (`repo`, `workflow` scopes)
- Claude Max subscription → `claude setup-token` for `CLAUDE_CODE_OAUTH_TOKEN`
- Docker Desktop (for self-hosted runners)
- At least one self-hosted runner registered to your fork

---

## Running locally

```bash
git clone https://github.com/pA1nD/claw-studio
cd claw-studio
npm install

cp .env.example .env
# Fill in GITHUB_PAT and CLAUDE_CODE_OAUTH_TOKEN

npm run dev          # runs src/cli/index.ts via tsx
npm run build        # compiles to dist/
npm test             # runs vitest
npm run lint         # eslint
```

---

## Project structure

```
src/
  core/       business logic — no UI concerns
    github/   Octokit client (ALL GitHub calls go here)
    roadmap/  ROADMAP.md parser
    checks/   repo state inspector
    agents/   implementation agent, session management
    git/      git operations
    loop/     orchestrator
    types/    shared types and error definitions
  cli/        Claw CLI — Ink terminal UI
  app/        Claw Studio desktop app — Electron, v0.2+ (not yet)
tests/        mirrors src/ structure
```

---

## Making changes

All changes go through a PR. The review pipeline runs automatically:

1. Fork the repo
2. Create a branch: `claw/issue-{N}-{slug}` or `feat/your-feature`
3. Make your changes
4. Open a PR — 5 review agents will fire automatically
5. Fix any CHANGES REQUESTED
6. All 5 approved → squash merge

Branch protection is enforced — direct pushes to main are blocked.

---

## Self-hosting the GitHub connection

For self-hosted setups, use the device flow — no client secret required:

```bash
GITHUB_AUTH_STRATEGY=device claw setup --repo owner/repo
```

This opens a browser to `github.com/login/device`, you enter a code, done. The token is stored in `.env` locally.

---

## Running your own review agents

Self-hosted runners power the review agents. To register runners:

1. Go to your repo → Settings → Actions → Runners → New self-hosted runner
2. Follow GitHub's instructions to register a runner on your machine
3. Repeat for as many runners as you need (recommend 6 minimum for 5 parallel agents + summary)

Using Docker (recommended):

```bash
# See the runner setup in the repo root
# Adapt ~/claw-studio-runners/docker-compose.yml for your repo
```

---

## Architecture decisions

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full technical rationale behind every major decision.

---

## Code standards

- TypeScript strict mode — no `any`
- Every public function has a JSDoc comment
- Every module has a matching test file in `tests/`
- No `@ts-ignore` or `eslint-disable`
- Errors are typed — see `src/core/types/errors.ts`
- All GitHub API calls go through `src/core/github/client.ts`

---

## Filing issues

Issues should follow the format used in the v0.1 milestone:
- Clear `## What` and `## Why` sections
- Explicit acceptance criteria
- `## Human steps` section if any manual steps are required

---

## License

MIT — by contributing you agree your contributions are licensed under MIT.
