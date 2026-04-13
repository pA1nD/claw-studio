# Claw Studio — Agent Instructions

You are building Claw Studio: a CLI loop that autonomously implements GitHub issues
using Claude Code agents. Read ROADMAP.md and README.md before starting any work.

## Context files

@ROADMAP.md
@README.md

## Stack
- TypeScript — strict mode, no `any`
- Node.js 20+
- No heavy frameworks — this is a CLI tool, keep dependencies minimal
- `@octokit/rest` for GitHub API calls
- `execa` for spawning shell commands and Claude Code CLI
- `vitest` for tests

## Project structure

    src/
      checks/     one file per state check (check-01-roadmap.ts, check-02-milestone.ts, ...)
      agents/     implementation agent, review agents
      git/        all git operations (branch, rebase, merge, squash-merge, delete)
      loop/       main orchestrator
      cli/        claw start, claw status, claw pause, claw resume
      types/      shared TypeScript types
    tests/
      checks/     one test file per check
      agents/
      git/
      loop/

## Coding standards
- Every public function has a JSDoc comment
- Errors are typed — define error types in src/types/errors.ts, never throw raw strings
- No `@ts-ignore` or `eslint-disable` — fix the actual problem
- Each module has its own test file in the matching tests/ directory
- Functions are small and composable — if a function does two things, split it

## Git rules
- Never commit directly to main
- Branch naming: `claw/issue-{N}-{slug}`
- Squash merge only
- Delete branch after merge
- Never force-push

## Error philosophy
- All errors surface to the human — no silent failures
- Error messages follow this format:
  [CLAW] Stopped — {what is wrong}
  {what to look at or do}
  Run `claw status` to re-check once resolved.
- The loop halts on first failed check — never continues past an unknown state

## Human steps convention

Every issue may have a `## Human steps` section at the bottom. When you see one:

- If it says **"do these BEFORE"** — stop. Walk the human through each step
  interactively before writing any code. One step at a time. Wait for confirmation
  before proceeding to the next. Only start implementation once all steps are done.

- If it says **"do these AFTER"** — implement everything first, then walk the human
  through the steps at the end.

How to walk a human through a step:
- State what you need and why in one sentence
- Give the exact command or URL
- Wait for their input
- Validate it before moving on
- If it fails — explain clearly, suggest the fix, ask to retry
- Never move to the next step until the current one is confirmed

Keep it conversational. One thing at a time. Plain English. No jargon.

## What to avoid
- Do not add features not described in the current issue
- Do not refactor code outside the scope of the current issue
- Do not skip tests — if behaviour is not tested, it is not trusted
- Do not use process.exit() directly — use the typed error system
