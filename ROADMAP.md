# Claw Studio — Roadmap

> **Claw your way.**
>
> Claw Studio is a software factory. You describe an idea. Agents build it — issue by issue,
> milestone by milestone — while you watch it happen on a living dashboard. No code. No terminal.
> No developers required.
>
> Two users: a programmer-turned-product-manager who thinks in outcomes, and a chairman who thinks
> in ideas. Same interface. Different depths. Both at home.

---

## Current milestone: v0.1 — The Loop

---

## v0.0 — Project Setup
*Do this first. Manually. Once.*

Before the loop can run, the project needs a home. This milestone creates everything
the loop expects to find — repo structure, workflows, labels, runners, CLAUDE.md.

This milestone is completed by a human, not by the loop. It is a one-time setup.
Once done, mark v0.1 as current and the loop takes over permanently.

### User stories
- As a PM, I can run `claw status` and see all checks passing with no errors
- As a PM, I can run `claw start --repo pA1nD/claw-studio` and the loop begins immediately
- As anyone, the repo is in a clean, known state before the first agent touches it

### What to set up

**Repository**
- `main` branch exists and is the default
- Branch protection on `main`: require PR, require CI to pass, no direct push

**Files**
- `ROADMAP.md` — exists, current milestone marked (this file)
- `README.md` — exists
- `CLAUDE.md` — coding standards and architecture for this project
- `.github/workflows/ci.yml` — lint, typecheck, tests, and all 5 review agents (one file)
- `.env.example` — documents required environment variables
- `package.json` — project scaffold with correct dependencies
- `tsconfig.json` — strict TypeScript config
- `.eslintrc.json` — ESLint config for TypeScript

**GitHub labels**
- `v0.0` — purple, "Milestone 0 — Project Setup"
- `v0.1` — amber, "Milestone 1 — The Loop"
- `needs-human` — red, "Escalated — requires human decision"

**GitHub Actions secrets**
- `CLAUDE_CODE_OAUTH_TOKEN` — from `claude setup-token` on your Mac

**Local runners**
- 6 self-hosted runners registered and showing as Idle in Settings → Actions → Runners

### CLAUDE.md minimum contents

```markdown
# Claw Studio — Agent Instructions

## Stack
- TypeScript (strict mode)
- Node.js 20+
- CLI tool — keep it lean, no unnecessary frameworks

## Coding standards
- Functional, composable functions over classes
- Every public function has a JSDoc comment
- Errors are typed — no throwing raw strings
- No `any` types

## Structure
- src/checks/   — one file per check in the state inspector
- src/agents/   — implementation agent, review agents
- src/git/      — all git operations
- src/loop/     — orchestrator
- src/cli/      — claw start, status, pause, resume

## Human steps convention

Issues may contain a `## Human steps` section at the bottom declaring steps that
cannot be automated. When present:

- **"do these BEFORE"** → walk the human through each step interactively before
  writing any code. One step at a time. Validate each before proceeding.
- **"do these AFTER"** → implement first, then walk through the steps at the end.

Keep it conversational. One thing at a time. Plain English. No jargon.

## Rules
- Never commit directly to main
- Never use @ts-ignore or eslint-disable
- All errors surface to the human — no silent failures
- Each module has its own test file
```

### Done when
`claw status` reports all checks passing.
Update ROADMAP.md: change current milestone from v0.0 to v0.1.

---

## v0.1 — The Loop
*The engine. Everything else sits on this.*

The loop is the core of Claw Studio. It reads a roadmap, finds the current milestone, takes the
first open issue, implements it, opens a PR, runs review agents, fixes blocking issues, merges,
and moves to the next. Fully autonomous. No human prompts required.

This milestone proves the factory works. The UI comes later. The engine comes first.

### User stories
- As a PM, I point Claw Studio at any GitHub repo with a ROADMAP.md and it implements issues
  autonomously — one by one, in milestone order — until the milestone is done
- As a PM, I can go to sleep with 10 open issues and wake up to 10 merged PRs
- As a PM, nothing merges without all 5 review agents approving it
- As a PM, I can point the loop at a repo mid-flight — with PRs already open, branches already
  existing — and it picks up correctly without duplicating or skipping work
- As a PM, I know the loop reads the roadmap and respects milestone order — it never starts v0.2
  issues while v0.1 issues remain open

### What it does

**Roadmap and milestone structure**
- Reads `ROADMAP.md` on startup to understand milestone structure and ordering
- Identifies the current milestone (labeled as such in the roadmap)
- Reads all GitHub issues labeled with the current milestone, sorted by issue number
- Implements issues in order — one at a time, fully complete, before moving to the next
- Pauses at milestone boundary with optional human confirmation before starting the next milestone

**The implementation cycle (per issue)**
1. Inspect repo state — classify into one of the defined states (see below)
2. Spawn implementation agent with full context: issue body, ROADMAP.md, CLAUDE.md, README.md,
   all open and closed issues in the current milestone
3. Agent implements, commits to `claw/issue-{N}-{slug}` branch, opens PR with `Closes #N` in body
4. Spawn 5 parallel review agents: Arch, DX, Security, Perf, Test — each posts a PR comment
   with verdict: APPROVED or CHANGES REQUESTED + one sentence why
5. Summary agent reads all 5 verdicts, posts a summary table, determines overall verdict
6. If APPROVED by all → squash merge to main, delete branch, move to next issue
7. If CHANGES REQUESTED → fix agent reads all blocking comments, implements fixes, pushes to
   same branch, triggers re-review (back to step 4)
8. Repeat until approved or escalation threshold reached

**Repo state machine**
The loop inspects the repo on startup and on each cycle. Given any state, there is exactly one
correct action. No ambiguity.

| State | Condition | Action |
|---|---|---|
| 1 | No open PRs, no open issues in milestone | Milestone complete → pause, notify human |
| 2 | No open PRs, open issues exist | Pick first issue by number, implement |
| 3 | Open PR exists, no review comments yet | Trigger review agents on existing PR |
| 4 | Open PR exists, all agents approved, CI green | Merge, delete branch, next issue |
| 5 | Open PR exists, blocking issues flagged | Run fix agent on same branch |
| 6 | Open PR exists, 3 fix attempts, still blocked | Escalate → `needs-human`, next issue |
| 7 | Open PR exists, linked issue is closed | Close stale PR, next open issue |
| 8 | Multiple open PRs exist | Close all but oldest, treat as state 3/4/5 |
| 9 | Branch exists, no PR open | Open PR from existing branch, state 3 |
| 10 | Branch exists, PR exists, branch behind main | Rebase (if no review comments) or merge main in |
| 11 | Current issue labeled `needs-human` | Skip, next issue. All skipped → pause milestone |
| 12 | No ROADMAP.md found | Stop → alert: "I need a roadmap to know what to build" |
| 13 | ROADMAP.md exists, no current milestone | Stop → alert: "Which milestone should I work on?" |

**Git strategy**
- Branch naming: `claw/issue-{N}-{slug}` — always prefixed `claw/` so the loop never touches
  human branches
- Rebase on main before opening a PR — always
- Rebase on main before merging — if main has moved since branch was created
- Never rebase a branch that already has open review comments — merge main in instead to
  preserve comment thread
- Squash merge only — one commit per issue, message: `fix: [issue title] (closes #N)`
- Delete branch immediately after merge
- Never commit directly to main
- Never force-push
- Never touch branches not prefixed with `claw/`

### Error handling — v0.1: hardcoded checks, halt on first failure

On startup and on each cycle, the loop runs ordered checks. First failure halts with a
plain-English error. No self-healing. No AI suggestions. No silent mutations. Human fixes
the problem, then resumes.

This is intentional. v0.1 proves the engine works. Recovery intelligence comes in v0.5+.

Checks in order (first failure halts):
1. ROADMAP.md exists
2. Current milestone is marked
3. Issues exist for this milestone (open or closed)
4. Not all issues closed — if yes, pause and notify (happy-path terminal)
5. Current issue not labeled `needs-human`
6. At most one open `claw/` branch
7. No open PR with missing linked issue
8. No branch without an open PR
9. No branch behind main
10. No missing review agents on open PR
11. No PR blocked after 3 fix attempts
12. CI not failing on open PR
13. Catch-all — anything unexpected → halt and describe

Every error follows the same format:
```
[CLAW] Stopped — {what is wrong}
{what to look at or do}
Run `claw status` to re-check once resolved.
```

### Done when
sheetsdb completes a full milestone autonomously without a single manual prompt, correctly
handling a repo that already has open PRs and partial work in progress

---

## v0.2 — Single Project Dashboard
*The loop made visible.*

The first UI. An Electron app that shows a single project building in real time — a live git
graph, agent avatars, milestone progress, and the full micro-copy system. This is where Claw
Studio becomes something you can show someone.

### User stories
- As a PM, I watch a live git graph — branches growing, agents working, commits landing in real time
- As a chairman, I open Claw Studio and immediately feel something is being built for me
- As a chairman, I see *Clawing at moonbeams.* and feel the energy of work happening on my behalf
- As anyone, I see *Clawed.* ✓ and confetti when a milestone ships
- As anyone, I click a completed milestone and open the live software

### What it does
- Electron app, single window, dark warm theme (Gruvbox-adjacent, amber accents)
- Live git graph — branches per issue, agent avatars at branch tips, pulsing when active
- Agent avatars: Arch (blue), Security (red), DX (purple), Perf (amber), Test (green),
  Implementation (white/bright)
- Commit nodes along each branch — small, clean, timestamped on hover
- Milestone progress bar — issues completed vs total, current milestone name
- Real-time updates via GitHub API polling (webhook upgrade later)
- Full micro-copy system throughout
- Confetti on milestone complete — warm amber/orange particles, 2 seconds, tasteful
- Live link card on milestone complete: "Your idea. Live."
- Fallback to simple issue list if git graph fails to render — never blank screen

### Micro-copy states
| Moment | Copy |
|---|---|
| Onboarding | *Claw your way.* |
| First prompt | *What's the idea?* |
| Agent starts | *Claw me, claw thee.* |
| Agents working | *Clawing at moonbeams.* |
| Agent stuck | *Clawing it back...* |
| Milestone ships | *Clawed.* ✓ |
| Live software | *Your idea. Live.* |
| All done | *Fully clawed.* |
| Something broke | *Lost the claw.* |
| Fixed | *Back.* |

### Human steps lookahead

The dashboard scans all upcoming issues in the current milestone and checks for
`## Human steps` sections. If any are found, a subtle notice appears:

```
⚠ Human input needed in 3 issues (~45 min)
   Issue #6 — Git strategy: 2 steps required
   View details →
```

Clicking "View details" shows exactly what steps are coming and approximately when,
so the human can prepare ahead of time if possible — or at least not be surprised.

The lookahead is passive — it never blocks the loop. It's purely informational.
The notice dims when the relevant issue starts and disappears once steps are complete.

### Error handling
- GitHub API unreachable → show last known state, amber pulse, *"Reconnecting..."*
- Runner goes offline → agent avatar dims immediately, no crash, no alert unless offline >5 minutes
- Git graph fails to render → fallback to issue list, never blank screen

### Done when
A non-technical person watches a milestone build in real time and says "I get it" without
being explained anything

---

## v0.3 — Mission Control
*The factory floor from above.*

Add a multi-project overview. See all projects simultaneously — each alive, each showing
progress, each with a status light. The aggregate feeling: many things happening, I am in control.

### User stories
- As a PM, I see all my projects in one view — each alive, each showing progress
- As an IT head, I see every project across the company at a glance
- As a chairman, I feel the awe of many things happening simultaneously for me

### What it does
- Sidebar: list of all projects
- Main view: grid of project cards — each showing miniature git graph, current milestone, status
- Status lights: green (running), amber (needs attention), red (escalated/paused)
- Click any project → Single Project Dashboard
- Aggregate stats: total agents working, issues completed today, runners idle vs busy
- If >50% of projects red → banner: *"Something's up. Check your runners."*

### Runner pool visibility — first introduced here
Mission Control is the first place where runner capacity becomes visible and relevant.
With multiple projects running in parallel, the runner pool is the throughput ceiling.

The dashboard shows:
- Total runners registered
- Runners currently busy vs idle
- Jobs queued waiting for a runner
- Estimated wait time based on current queue depth

**The math:** each project can fire 5 review agents simultaneously. With 10 projects
and 6 runners, that's up to 50 concurrent jobs against a pool of 6 — 44 queuing.
The dashboard makes this visible so the human knows why things feel slow.

Runner sizing guidance (shown in the UI):
- 1 project active: 6 runners comfortable
- 3-5 projects active: 12-15 runners recommended
- 10+ projects active: 1 runner per expected concurrent agent (up to hardware limit)

Note: runner scaling is a hardware problem — more runners = more CPU/RAM on the host.
The right number depends on the machine Claw Studio runs on. v0.6 addresses this
properly when runners are bundled and auto-sized to available hardware.

### Done when
Three projects run simultaneously and are visible from one Mission Control screen,
with runner pool status clearly visible

---

## v0.4 — Drill Down
*Attention where it's needed.*

Click into any blocked agent or broken branch and immediately understand what happened — in
plain English. No jargon on the surface. Technical detail one click deeper for the PM who wants it.

### User stories
- As a PM, I click a blocked agent and immediately understand why in plain English
- As a chairman, I read one sentence and know what's happening
- As a chairman, I never need to open GitHub to understand a problem
- As a chairman, I can show the drill-down to my PM and say "look at this"

### What it does
- Click any agent avatar or branch → drawer slides in from right
- Plain English summary: what happened, what's being done about it
- Review agent verdicts — summarised, not raw
- Timeline: what happened and when
- *"This needs you."* CTA if human action required — one sentence, one button
- Technical detail (PR diff, raw comments) one click deeper — available to PM, invisible to chairman
- Escalated issues stay visible until human explicitly resolves or dismisses

### Done when
The chairman clicks a red pulse, reads the drawer, and can explain to someone else what broke

---

## v0.5 — The Idea Layer
*The chairman's front door.*

Natural language idea intake. The chairman types an idea. Claw Studio asks a few clarifying
questions, generates a spec, breaks it into milestones and issues, creates the GitHub repo and
structure, and starts the loop — all without the chairman touching a terminal or GitHub.

### User stories
- As a chairman, I type an idea in plain language and watch a project appear
- As a PM, I review and refine the generated spec before agents start
- As an assistant, I describe my workflow problem and get software built for it
- As anyone, I go from idea to agents working in under 5 minutes

### What it does
- Conversational intake: *"What's the idea?"* → clarifying questions → spec generated
- Spec → ROADMAP.md → milestones → GitHub issues — all automatic
- PM review step: approve or edit before loop starts — never auto-starts without review
- New project appears in Mission Control, loop begins
- Spec generation failure always surfaces to human for review — never auto-starts from a bad spec

### Custom review agent prompts — generated per project

The review agent prompts in `ci.yml` are no longer hardcoded. When the system generates
a project from an idea, it also generates custom agent prompts tailored to that specific
project — what data it handles, what the performance requirements are, what the security
surface looks like, what tech stack was chosen.

The Security agent for a supplier tracking tool gets different instructions than the
Security agent for a payment processor. The Perf agent for a low-volume internal tool
asks different questions than the Perf agent for a high-frequency API.

**How it works**

When the spec is generated from the idea, Claude extracts:
- Tech stack and dependencies
- Data sensitivity (does it handle PII, credentials, financial data?)
- Performance profile (internal tool vs public API, expected load)
- Architecture pattern (CLI, web app, API, library)
- Domain-specific risks

These feed into custom agent prompts written into `ci.yml` at project creation time.
The agents understand the project before the first PR is opened.

**Example — supplier tracking tool vs payment processor**

```
Arch (supplier tool):    focus on data model consistency, import/export reliability
Arch (payment processor): focus on transaction atomicity, audit trail, rollback patterns

Security (supplier tool):    check for accidental PII exposure in logs
Security (payment processor): BLOCKING on any plaintext financial data, PCI compliance patterns

Perf (supplier tool):    flag unnecessary full-table scans on small datasets
Perf (payment processor): flag anything that could block the payment critical path
```

### In-UI human step wizard

When an issue with `## Human steps` becomes active, the dashboard doesn't send the
human to a terminal. A panel slides in from the right — the same drawer used for
drill-down — and an agent walks the human through each step conversationally,
right inside the UI.

```
┌─────────────────────────────────────────┐
│ Your input needed                    ✕  │
│─────────────────────────────────────────│
│ Issue #6 requires a few things from you │
│ before I can continue. Takes ~2 min.    │
│                                         │
│ Step 1 of 2 — GitHub token             │
│                                         │
│ I need a GitHub token to manage         │
│ branch protection on this repo.         │
│                                         │
│ Go to: github.com/settings/tokens/new  │
│ Scopes: repo, workflow, admin:org       │
│                                         │
│ Paste your token:                       │
│ ┌─────────────────────────────────────┐ │
│ │ ghp_                                │ │
│ └─────────────────────────────────────┘ │
│                              [Continue] │
└─────────────────────────────────────────┘
```

The loop pauses on the current issue while the wizard is open.
Once all steps are complete, the loop resumes automatically.

Rules for the wizard:
- One step at a time — never show step 2 until step 1 is validated
- Validate every input before proceeding — wrong token = clear error + retry
- Plain English — no jargon, no stack traces
- The chairman completes it without help
- Escape or close = loop stays paused, wizard reopens next time

### AI-driven recovery — also introduced here

From v0.5 onwards, the hardcoded check-and-halt approach from v0.1 evolves into an
intelligent recovery layer. When a check fails, instead of just halting, the loop:

1. Describes what is wrong (same as v0.1)
2. Analyses the situation using Claude
3. Proposes a concrete recovery action in plain English
4. Waits for human confirmation before acting

The recovery suggestion appears in the same drawer as the human step wizard —
consistent UX for all human interaction, whether planned (human steps) or
unplanned (loop escalation).

The human stays in control. The loop becomes a helpful advisor rather than a brick wall.

### Done when
The chairman describes an idea with no technical help, agents start working within 5 minutes,
the review agents in the generated ci.yml are clearly tailored to that specific project,
and when human steps are required the in-UI wizard guides them through without
ever opening a terminal

---

## v0.6 — The Executable
*Anyone can install it. No third-party accounts required.*

Package everything into a single `.dmg`. No terminal. No Docker Desktop. No GitHub account.
No manual config. The chairman double-clicks and has the full factory running in minutes.

This milestone breaks the dependency on GitHub. All third-party tools become optional integrations
for power users — not requirements. Claw Studio runs entirely self-contained.

### User stories
- As a chairman, I double-click a `.dmg` and have the full product running — no accounts, no setup
- As a chairman, I describe an idea and watch it get built without ever hearing the word "GitHub"
- As a PM, I send the `.dmg` to anyone and they're productive in 5 minutes
- As IT, I deploy Claw Studio company-wide without any individual needing a GitHub account
- As a power user, I can optionally connect GitHub to use my existing repos and workflows

### What it does

**Bundled — no external dependencies required**
- Single `.dmg` for macOS (Windows `.exe` to follow)
- Bundles: Electron app, Docker runners, Claude Code CLI, Git (local), internal issue store
- First-run wizard: Claude Max auth via `setup-token` → runners start → ready in under 2 minutes
- Internal version control: Git runs locally, no remote required
- Internal issue store: milestones, issues, ordering — all managed inside Claw Studio
- Internal CI: lint, typecheck, tests run in bundled Docker containers — same infrastructure
  as the agent runners, now also serving as the CI environment
- Internal review agents: run on bundled local runners — no GitHub Actions
- Internal hosting: live link served locally, or one-click deploy to a simple platform
- Auto-update built in

Note on CI containers: in v0.1–v0.5, CI (lint/typecheck/tests) runs on GitHub's hosted
ubuntu-latest runners — GitHub's infrastructure, GitHub's problem. From v0.6 onwards,
CI moves into the same bundled Docker environment as the agent runners. The containers
need to include the right language runtimes (Node 20, etc.) for whatever the project
being built requires.

**Runner auto-sizing — critical for parallel project throughput**

When runners are bundled, Claw Studio must right-size the pool to the hardware it's
running on. This is not optional — too few runners and projects queue; too many and
the host runs out of memory and everything slows down.

On first run, Claw Studio measures available hardware and recommends a runner count:

```
Detected: Apple M3 Max — 16 cores, 48GB RAM
Each runner uses approximately: 1 core, 2GB RAM
Recommended runners: 12 (leaves headroom for the OS and dashboard)
Current setting: 6

Run 10 projects in parallel? You'll need ~20 runners.
Increase to 12? [Y/n]
```

The formula is simple: each runner handles one agent job at a time. With 5 review
agents per PR and N projects active, you need at least 5×N runners to avoid queuing.
In practice, not all projects fire simultaneously, so 3×N is a reasonable starting point.

The dashboard always shows runner utilisation — if jobs are consistently queuing,
it suggests increasing the pool. If runners are consistently idle, it suggests
reducing to free up memory for other things.

Runner scaling is ultimately a hardware problem. Claw Studio surfaces the information
and makes it easy to adjust — but the ceiling is the machine it runs on.

**GitHub becomes optional**
- Connect GitHub to sync issues, use existing repos, push to remote, trigger GitHub Actions
- Useful for PMs and developers who already live in GitHub
- Completely invisible to users who don't want it
- No feature is locked behind GitHub — everything works without it

**Error handling**
- Auth failure → guided re-auth, never blank screen
- Runner down → auto-restart, visible on dashboard, human notified only after 3 failed restarts
- Update fails → stays on current version, never breaks existing install

### Done when
Someone with no GitHub account, no terminal knowledge, and no technical background installs
Claw Studio, describes an idea, and watches agents build it — entirely without external services

---

## v0.7 — Collaboration
*Two people, one project.*

Share a project with another person. Watch it build together. The chairman and PM on the same
dashboard simultaneously — each with different depths of detail available.

### User stories
- As a chairman, I invite my PM and we watch the project build together
- As a chairman, I comment on a milestone and the PM sees it immediately
- As a PM, I approve a milestone before agents move to the next one
- As a team, we share one Mission Control across all projects

### What it does
- Project sharing via invite link
- Shared real-time dashboard — same live git graph for all collaborators
- Comments on milestones and issues — visible to all
- Optional approval gate at milestone boundaries — PM signs off before next milestone starts
- Approval gate times out after 48 hours → reminder escalation, loop stays paused
- Conflicting simultaneous actions → last write wins, both notified

### Done when
Chairman and PM watch the same project build simultaneously from different machines

---

## v0.8 — Living Software
*It runs. It heals. You just watch.*

Every milestone that ships gets deployed automatically. Production is monitored. Bugs are
detected, filed as issues, fixed by the loop, and redeployed — before the chairman even notices
something was wrong. The full lifecycle of software — development and production — visible in
one git graph.

### User stories
- As a chairman, my software is deployed and running — I never think about servers
- As a chairman, when something breaks I see it on the dashboard before anyone tells me —
  and a fix is already running
- As a user of software built with Claw Studio, bugs are fixed before I notice them
- As an IT department, I run the entire company's internal software stack from one Mission Control

### What it does
- Auto-deployment on milestone merge — live URL appears in dashboard, always current
- Production monitoring — errors surface as human-readable events, never stack traces
- Autonomous bug filing — monitoring detects error, creates GitHub issue with full context
- Loop picks up the bug issue and fixes it — same loop as development
- Production and development activity visible in the same git graph
- Deployment fails → automatic rollback to last working version, issue filed, loop attempts fix
- Same bug persists after 2 auto-fix attempts → escalate: *"This one needs you."*
- Production fully down → loop deprioritises all other work, fixes this first

### Done when
A production bug is detected, fixed, and deployed without the chairman doing anything —
and he can see the whole cycle on the dashboard

---

## North star

> Anyone describes any software idea.
> Claw Studio builds it.
> Milestone by milestone.
> They watch it happen.
> They never think about code.
>
> **Claw your way.**
