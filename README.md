# Claw Studio

**Claw your way.**

Describe a software idea. Watch agents build it — issue by issue, milestone by milestone — on a living dashboard. No code. No terminal. No developers required.

---

## What is this?

Software development has a problem. The people with the best ideas — founders, domain experts, operations managers, chairmen with decades of pattern recognition — have never been able to build the software they imagine. They've always needed a middleman: a developer, an agency, a six-month roadmap and a six-figure budget.

That's over.

Claw Studio is a software factory. You describe what you want. A pipeline of AI agents implements it, reviews it, fixes it, and ships it — milestone by milestone — while you watch the whole thing happen on a beautiful dashboard. When a milestone ships, you get a live link. A real thing you can click, use, and show people.

The programmer-turned-product-manager uses it to think at the product level without touching code. The 70-year-old chairman uses it to finally build the tools he's been imagining for 40 years. The assistant uses it to solve the workflow problem nobody else could be bothered to fix. The IT department uses it to build every internal tool the company needs, faster than any vendor could deliver.

Nobody writes code. Everybody ships software.

---

## How it works

```
You describe an idea
        ↓
Claw Studio generates a roadmap
        ↓
Roadmap → milestones → GitHub issues
        ↓
Loop starts:
  pick issue → implement → open PR → 5 review agents run in parallel
        ↓
  Arch reviews architecture
  Security scans for vulnerabilities  
  DX checks developer experience
  Perf flags performance issues
  Test verifies coverage
        ↓
  All approved → squash merge → next issue
  Blocked → fix agent → re-review → repeat
        ↓
Milestone complete → deploy → live link → confetti
        ↓
Next milestone
        ↓
Fully clawed. ✓
```

The loop runs autonomously. You watch it on the dashboard. When something needs your attention, one light dims and a single sentence tells you why. Most of the time, you just watch.

---

## The dashboard

The main view is a living git graph. Multiple branches flow in parallel — each one an agent working on an issue. Branches diverge from main, grow commit by commit, converge back when merged. Agent avatars pulse at the tip of each branch. The factory is always moving.

When a milestone completes: *Clawed.* ✓ A warm ripple. Confetti that lasts exactly two seconds. A live link to the running software. Then back to work.

When something breaks: one agent dims. A slow pulse. A single human-readable sentence. No alert box. No stack trace. Just a light that's different from all the others, asking quietly for your attention.

Mission Control shows every project at once. Dozens of ideas being built simultaneously. Status lights everywhere — green, amber, red. The aggregate feeling of a factory running on your behalf.

---

## The brand

**Claw** /klɔː/ — from Old English *clawu*, Proto-Indo-European *\*kel-* meaning "to seize, to grip." The original tool. How living things reach out and change the world. Also: a quiet nod to the model underneath. The people who know, know.

| Moment | What you see |
|---|---|
| Opening the app | *Claw your way.* |
| Starting a project | *What's the idea?* |
| Agents beginning work | *Claw me, claw thee.* |
| Agents actively building | *Clawing at moonbeams.* |
| Agent hit a snag | *Clawing it back...* |
| Milestone ships | *Clawed.* ✓ |
| Seeing it live | *Your idea. Live.* |
| Everything done | *Fully clawed.* |
| Something broke | *Lost the claw.* |
| Back on track | *Back.* |

---

## Architecture

Claw Studio is GitHub-native. GitHub is the source of truth, the event bus, and the persistence layer. Nothing custom underneath — just the best tools, wired together properly.

```
Claw Studio (Electron)
├── Dashboard — live git graph, agent avatars, milestone progress
├── Orchestrator — reads roadmap, manages loop state, routes work
└── GitHub API — issues, PRs, comments, webhooks

GitHub
├── ROADMAP.md — milestone definitions and ordering
├── Issues — one per feature, labeled by milestone
├── PRs — opened by implementation agent, reviewed by review agents
└── Actions — CI runs on every PR, required to pass before merge

Local runners (Docker)
├── myoung34/github-runner × N — one per parallel agent
└── claude -p — implementation and review agents, Max subscription
```

No cloud compute costs. No GitHub Actions minutes billing. Everything runs on your machine, powered by your Claude Max subscription.

---

## Repo structure

Every project built with Claw Studio follows this structure:

```
your-project/
├── ROADMAP.md          # Milestone definitions — the loop reads this first
├── CLAUDE.md           # Agent instructions — coding standards, architecture decisions
├── README.md           # What this project is
└── .github/
    └── workflows/
        ├── ci.yml              # Lint, typecheck, tests — must pass before merge
        ├── agent-review.yml    # 5 parallel review agents on every PR
        └── auto-fix.yml        # Fix agent triggers on CI failure
```

The loop never touches branches not prefixed with `claw/`. It never commits directly to main. It never merges without CI green and all review agents approved. It never loops forever — escalation thresholds are hard limits.

---

## Loop behaviour

The loop is deterministic. Given any repo state, there is exactly one correct action.

| Repo state | What the loop does |
|---|---|
| No open PRs, open issues exist | Implement the first issue |
| PR open, no reviews yet | Trigger review agents |
| PR open, all approved, CI green | Squash merge, next issue |
| PR open, blocking reviews | Run fix agent |
| Fix attempted 3× still blocked | Escalate → `needs-human`, next issue |
| Branch exists, no PR | Open PR, trigger reviews |
| Branch behind main, no review comments | Rebase on main |
| Branch behind main, review comments exist | Merge main in (preserve comment thread) |
| All issues `needs-human` | Pause milestone, alert human |
| No ROADMAP.md | Stop — ask for one |

Git strategy: `claw/issue-{N}-{slug}` branches, squash merge only, branch deleted after merge, never force-push, never commit to main.

---

## Milestones

| Version | Name | Status |
|---|---|---|
| v0.1 | The Loop | 🔄 Current |
| v0.2 | Single Project Dashboard | Planned |
| v0.3 | Mission Control | Planned |
| v0.4 | Drill Down | Planned |
| v0.5 | The Idea Layer | Planned |
| v0.6 | The Executable | Planned |
| v0.7 | Collaboration | Planned |
| v0.8 | Living Software | Planned |

See [ROADMAP.md](./ROADMAP.md) for full milestone definitions, user stories, and error handling specs.

---

## Running locally

> v0.1 — the loop runs headlessly. No UI yet. That comes in v0.2.

**Prerequisites**
- macOS (Apple Silicon or Intel)
- Docker Desktop running
- Claude Max subscription
- GitHub account with a PAT (repo + admin scope)

**Setup**

```bash
# 1. Clone
git clone https://github.com/YOUR_ORG/claw-studio
cd claw-studio

# 2. Generate your Claude Max OAuth token
claude setup-token
# → save the output: sk-ant-oat01-...

# 3. Configure environment
cp .env.example .env
# Edit .env — add GITHUB_PAT and CLAUDE_CODE_OAUTH_TOKEN

# 4. Start runners
cd runners
docker compose up -d --build
# → 6 runners appear in your repo Settings → Actions → Runners

# 5. Point at a project
claw start --repo YOUR_ORG/YOUR_REPO
# → loop reads ROADMAP.md, finds current milestone, starts working
```

**Watch it run**

```bash
claw status          # current state of the loop
claw logs            # live agent output
claw pause           # pause after current issue completes
claw resume          # resume
```

---

## Requirements for your project repo

For the loop to work, your project repo needs:

**ROADMAP.md** — milestone definitions with a clearly marked current milestone

**GitHub issues** — labeled with their milestone (e.g. `v0.1`), ordered by priority via issue number

**CLAUDE.md** — agent instructions: coding standards, architecture decisions, what to avoid, what to prefer

**Branch protection on main** — require CI to pass, require PR review (the review agents count)

That's it. The loop handles everything else.

---

## Philosophy

Software development has never been about code. It's always been about ideas, outcomes, and human needs. Code is just the medium — and for most of human history, mastery of the medium was required to express the idea.

Claude Shannon proved in 1948 that information could be transmitted, stored, and processed mathematically — democratising communication theory. Claude the model makes that processing accessible in natural language. Claw Studio makes the output of that processing accessible to everyone with an idea.

The programmer-turned-PM thinks in outcomes. The chairman thinks in possibilities. The assistant thinks in daily frustrations. Claw Studio doesn't ask any of them to think in code.

**Your software. Built by agents. Clawed into existence.**

---

## Status

Early development. v0.1 in progress. Breaking changes expected.

If you're building something with Claw Studio or want to follow along: watch this repo.

---

*Claw your way.*
