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

### Error handling
- Implementation fails to open PR after 2 attempts → `needs-human` label, loop moves to next issue
- Review loop exceeds 3 fix attempts without full approval → escalate, pause issue, move to next
- CI fails after merge → revert squash commit, file new `claw/regression` issue, prioritise above queue
- Rebase conflict not auto-resolvable → `needs-human`, leave branch intact, alert with specific
  conflicting files — never force-push a conflicted resolution
- Loop idle >30 minutes with no state change → alert human, show current state
- GitHub API rate limited → pause, wait for reset, resume — never crash

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
- Aggregate stats: total agents working, issues completed today
- If >50% of projects red → banner: *"Something's up. Check your runners."*

### Done when
Three projects run simultaneously and are visible from one Mission Control screen

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

### Done when
The chairman describes an idea with no technical help and agents are working within 5 minutes

---

## v0.6 — The Executable
*Anyone can install it.*

Package everything into a single `.dmg`. No terminal. No Docker Desktop. No manual config.
The chairman double-clicks and has the full factory running in minutes.

### User stories
- As a chairman, I double-click a `.dmg` and have the full product running
- As a PM, I send the `.dmg` to anyone and they're productive in 5 minutes
- As IT, I deploy Claw Studio company-wide without any individual needing technical knowledge

### What it does
- Single `.dmg` for macOS (Windows `.exe` to follow)
- Bundles: Electron app, Docker runners, Claude Code CLI, GitHub auth flow
- First-run wizard: GitHub login → Claude Max auth via `setup-token` → runners start automatically
- Auto-update built in
- Auth failure → guided re-auth, never blank screen
- Runner down → auto-restart, visible on dashboard, human notified only after 3 failed restarts

### Done when
Someone with no technical knowledge installs Claw Studio and runs their first project from scratch

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
