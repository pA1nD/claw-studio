import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  buildEscalationComment,
  buildPullRequestBody,
  escalateIssue,
  runFixCycle,
  runImplementationAgent,
} from "../../../src/core/agents/implementation.js";
import type {
  ImplementationAgentDeps,
  OpenPullRequestArgs,
} from "../../../src/core/agents/implementation.js";
import type { Issue } from "../../../src/core/roadmap/parser.js";
import type { ClaudeInvocation } from "../../../src/core/agents/claude.js";
import type { RepoRef } from "../../../src/core/github/repo-detect.js";
import type { SessionFs } from "../../../src/core/agents/session.js";
import type { SessionFile } from "../../../src/core/checks/types.js";
import { MAX_FIX_ATTEMPTS, NEEDS_HUMAN_LABEL } from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

const CWD = "/tmp/project";
const REPO = "pA1nD/claw-studio";

function issue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    number: overrides.number,
    title: overrides.title ?? `Issue ${overrides.number}`,
    state: overrides.state ?? "open",
    labels: overrides.labels ?? ["v0.1"],
    body: overrides.body ?? `body ${overrides.number}`,
  };
}

/** In-memory filesystem for session files, with snapshots of writes/reads. */
function inMemorySessionFs(initial: Record<string, string> = {}): {
  fs: SessionFs;
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    fs: {
      readFile: async (path) =>
        Object.prototype.hasOwnProperty.call(store, path) ? store[path] ?? null : null,
      writeFile: async (path, contents) => {
        store[path] = contents;
      },
      removeFile: async (path) => {
        delete store[path];
      },
    },
  };
}

function sessionPathFor(issueNumber: number): string {
  return `${CWD}/.claw/sessions/${issueNumber}.json`;
}

function parseSessionAt(store: Record<string, string>, issueNumber: number): SessionFile | null {
  const raw = store[sessionPathFor(issueNumber)];
  if (!raw) return null;
  return JSON.parse(raw) as SessionFile;
}

/** Mock Octokit rich enough for `readDefaultBranch` inside the orchestrator. */
function stubOctokit(defaultBranch = "main"): Octokit {
  return {
    repos: {
      get: vi.fn(async () => ({ data: { default_branch: defaultBranch } })),
    },
  } as unknown as Octokit;
}

function buildDeps(overrides: Partial<ImplementationAgentDeps> = {}): {
  deps: ImplementationAgentDeps;
  openedPRs: Array<{ ref: RepoRef; args: OpenPullRequestArgs }>;
  claudeInvocations: ClaudeInvocation[];
  addedLabels: Array<{ ref: RepoRef; issueNumber: number; label: string }>;
  postedComments: Array<{ ref: RepoRef; prNumber: number; body: string }>;
  sessionStore: Record<string, string>;
} {
  const openedPRs: Array<{ ref: RepoRef; args: OpenPullRequestArgs }> = [];
  const claudeInvocations: ClaudeInvocation[] = [];
  const addedLabels: Array<{ ref: RepoRef; issueNumber: number; label: string }> = [];
  const postedComments: Array<{ ref: RepoRef; prNumber: number; body: string }> = [];
  const { fs, store } = inMemorySessionFs();

  const deps: ImplementationAgentDeps = {
    priorReviewNotes: {
      listCrossReferencedMergedPRs: vi.fn(async () => []),
      listPRComments: vi.fn(async () => []),
    },
    claude: {
      runClaude: vi.fn(async (inv: ClaudeInvocation) => {
        claudeInvocations.push(inv);
        return { sessionId: "sid-1", resultText: "did it" };
      }),
    },
    sessionFs: fs,
    readRepoFile: vi.fn(async (_ref: RepoRef, path: string) =>
      path === "README.md" ? "the README body" : "",
    ),
    openPullRequest: vi.fn(async (ref, args) => {
      openedPRs.push({ ref, args });
      return { number: 100 };
    }),
    addLabel: vi.fn(async (ref, issueNumber, label) => {
      addedLabels.push({ ref, issueNumber, label });
    }),
    postPRComment: vi.fn(async (ref, prNumber, body) => {
      postedComments.push({ ref, prNumber, body });
    }),
    ...overrides,
  };

  return { deps, openedPRs, claudeInvocations, addedLabels, postedComments, sessionStore: store };
}

describe("runImplementationAgent", () => {
  const baseInputs = {
    issue: issue({ number: 3, title: "Implementation agent" }),
    cwd: CWD,
    milestoneName: "v0.1",
    milestoneIssues: [issue({ number: 3, title: "Implementation agent" })],
    repo: REPO,
    roadmap: "## Current milestone: v0.1",
  };

  it("spawns claude, saves the session file, and opens a PR with `Closes #{N}`", async () => {
    const { deps, openedPRs, claudeInvocations, sessionStore } = buildDeps();
    const client = stubOctokit();

    const result = await runImplementationAgent(client, {
      ...baseInputs,
      deps,
    });

    expect(result).toEqual({
      branch: "claw/issue-3-implementation-agent",
      prNumber: 100,
      sessionId: "sid-1",
    });

    // Session persisted with fixAttempts: 0
    const saved = parseSessionAt(sessionStore, 3);
    expect(saved).toEqual({ issueNumber: 3, sessionId: "sid-1", fixAttempts: 0 });

    // PR body contains the exact `Closes #3` token — CHECK 7 depends on this
    expect(openedPRs).toHaveLength(1);
    const pr = openedPRs[0];
    expect(pr?.args.headBranch).toBe("claw/issue-3-implementation-agent");
    expect(pr?.args.baseBranch).toBe("main");
    expect(pr?.args.title).toBe("Implementation agent");
    expect(pr?.args.body).toContain("Closes #3");

    // Claude invoked with the expected CLI arg shape
    expect(claudeInvocations).toHaveLength(1);
    const inv = claudeInvocations[0];
    expect(inv?.args).toContain("--system-prompt");
    expect(inv?.args).toContain("--output-format");
    expect(inv?.args).toContain("json");
    expect(inv?.stdin).toContain("Implementation agent");
    expect(inv?.stdin).toContain("the README body");
    expect(inv?.stdin).toContain("claw/issue-3-implementation-agent");
  });

  it("continues without prior review notes when fetching them fails", async () => {
    const { deps } = buildDeps({
      priorReviewNotes: {
        listCrossReferencedMergedPRs: vi.fn(async () => {
          throw new Error("github boom");
        }),
      },
    });
    const client = stubOctokit();

    // Does not throw — prior notes are a prompt quality improvement, not a
    // correctness requirement. A transient failure must not halt the loop.
    await expect(
      runImplementationAgent(client, { ...baseInputs, deps }),
    ).resolves.toMatchObject({ prNumber: 100 });
  });

  it("rejects a malformed `repo` string with ClawError", async () => {
    const { deps } = buildDeps();
    const client = stubOctokit();

    await expect(
      runImplementationAgent(client, {
        ...baseInputs,
        repo: "not-a-repo",
        deps,
      }),
    ).rejects.toBeInstanceOf(ClawError);
  });
});

describe("runFixCycle", () => {
  const baseInputs = {
    issue: issue({ number: 3, title: "Implementation agent" }),
    cwd: CWD,
    repo: REPO,
    prNumber: 100,
    reviewComments: [
      { author: "Arch", body: "please rename X" },
      { author: "Test", body: "add a test for Y" },
    ],
  };

  function seedSession(store: Record<string, string>, attempts: number): void {
    store[sessionPathFor(3)] = JSON.stringify(
      { issueNumber: 3, sessionId: "sid-old", fixAttempts: attempts },
      null,
      2,
    );
  }

  it("throws a typed error when no session file exists (no fresh spawn)", async () => {
    const { deps } = buildDeps();
    const client = stubOctokit();

    await expect(
      runFixCycle(client, { ...baseInputs, deps }),
    ).rejects.toBeInstanceOf(ClawError);
    // Claude must NEVER be invoked without an existing session — that is the
    // drift the architecture is designed to prevent.
    expect(deps.claude?.runClaude).not.toHaveBeenCalled();
  });

  it("resumes the saved session and increments fixAttempts", async () => {
    const { deps, claudeInvocations, sessionStore } = buildDeps();
    seedSession(sessionStore, 0);
    const client = stubOctokit();

    const result = await runFixCycle(client, { ...baseInputs, deps });

    expect(result).toEqual({
      type: "fixed",
      attemptNumber: 1,
      sessionId: "sid-1",
    });

    // Resume invocation, not fresh spawn
    const inv = claudeInvocations[0];
    expect(inv?.args).toEqual([
      "-p",
      "--resume",
      "sid-old",
      "--output-format",
      "json",
    ]);
    // Every blocking review comment reached the prompt verbatim
    expect(inv?.stdin).toContain("please rename X");
    expect(inv?.stdin).toContain("add a test for Y");
    expect(inv?.stdin).toContain("fix attempt 1");

    // fixAttempts bumped and sessionId carried through
    expect(parseSessionAt(sessionStore, 3)).toEqual({
      issueNumber: 3,
      sessionId: "sid-1",
      fixAttempts: 1,
    });
  });

  it("escalates once fixAttempts hits MAX_FIX_ATTEMPTS after this attempt", async () => {
    const { deps, addedLabels, postedComments, sessionStore } = buildDeps();
    // Seed with MAX - 1 so this attempt lands at MAX
    seedSession(sessionStore, MAX_FIX_ATTEMPTS - 1);
    const client = stubOctokit();

    const result = await runFixCycle(client, { ...baseInputs, deps });

    expect(result).toEqual({
      type: "escalated",
      attemptsMade: MAX_FIX_ATTEMPTS,
    });

    // Label applied to the ISSUE, not the PR
    expect(addedLabels).toHaveLength(1);
    expect(addedLabels[0]).toEqual({
      ref: { owner: "pA1nD", repo: "claw-studio" },
      issueNumber: 3,
      label: NEEDS_HUMAN_LABEL,
    });

    // Comment posted on the PR
    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]?.prNumber).toBe(100);
    expect(postedComments[0]?.body).toContain("handed off for human review");

    // Session file deleted on escalation
    expect(sessionStore[sessionPathFor(3)]).toBeUndefined();
  });

  it("escalates without running Claude when the saved count is already at/over the limit", async () => {
    const { deps, claudeInvocations, sessionStore } = buildDeps();
    seedSession(sessionStore, MAX_FIX_ATTEMPTS);
    const client = stubOctokit();

    const result = await runFixCycle(client, { ...baseInputs, deps });

    expect(result).toEqual({
      type: "escalated",
      attemptsMade: MAX_FIX_ATTEMPTS,
    });
    // Most important — we must NOT burn another Claude run on a session
    // that has already exhausted its budget.
    expect(claudeInvocations).toHaveLength(0);
  });
});

describe("escalateIssue", () => {
  it("labels the issue, comments on the PR, and removes the session file in order", async () => {
    const { deps, addedLabels, postedComments, sessionStore } = buildDeps();
    sessionStore[sessionPathFor(3)] = "seed";
    const client = stubOctokit();

    await escalateIssue(client, {
      issue: issue({ number: 3, title: "Implementation agent" }),
      cwd: CWD,
      repo: REPO,
      prNumber: 55,
      attemptsMade: MAX_FIX_ATTEMPTS,
      reviewComments: [{ author: "Arch", body: "rename X" }],
      deps,
    });

    expect(addedLabels).toHaveLength(1);
    expect(addedLabels[0]?.label).toBe(NEEDS_HUMAN_LABEL);
    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]?.prNumber).toBe(55);
    expect(sessionStore[sessionPathFor(3)]).toBeUndefined();
  });
});

describe("buildPullRequestBody", () => {
  it("always ends with `Closes #{N}`", () => {
    const body = buildPullRequestBody(3, { sessionId: "s", resultText: "summary" });
    expect(body).toContain("summary");
    expect(body).toMatch(/Closes #3\n$/);
  });

  it("falls back to a placeholder when the agent reported no summary", () => {
    const body = buildPullRequestBody(3, { sessionId: "s", resultText: "   " });
    expect(body).toContain("(agent reported no summary.)");
    expect(body).toContain("Closes #3");
  });
});

describe("buildEscalationComment", () => {
  it("lists every review comment with a single-line excerpt", () => {
    const body = buildEscalationComment({
      issue: issue({ number: 3, title: "Agent" }),
      cwd: CWD,
      repo: REPO,
      prNumber: 55,
      attemptsMade: MAX_FIX_ATTEMPTS,
      reviewComments: [
        { author: "Arch", body: "rename X\n\nmore detail" },
        { author: "Test", body: "add coverage" },
      ],
    });
    expect(body).toContain("Arch: rename X");
    expect(body).toContain("Test: add coverage");
    expect(body).toContain(NEEDS_HUMAN_LABEL);
    expect(body).toContain(`${MAX_FIX_ATTEMPTS} fix cycles`);
  });

  it("uses singular wording for a single attempt", () => {
    const body = buildEscalationComment({
      issue: issue({ number: 3, title: "Agent" }),
      cwd: CWD,
      repo: REPO,
      prNumber: 55,
      attemptsMade: 1,
      reviewComments: [],
    });
    expect(body).toContain("1 fix cycle after review feedback");
  });
});
