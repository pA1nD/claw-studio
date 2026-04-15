import { describe, it, expect } from "vitest";
import type { Octokit } from "@octokit/rest";
import { inspectRepo, runChecks } from "../../../src/core/checks/inspector.js";
import type { RepoState } from "../../../src/core/checks/types.js";
import type { Milestone, Issue } from "../../../src/core/roadmap/parser.js";
import { NEEDS_HUMAN_LABEL } from "../../../src/core/checks/check-05-current-needs-human.js";

const stubClient = {} as Octokit;

function issue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    number: overrides.number,
    title: overrides.title ?? `Issue ${overrides.number}`,
    state: overrides.state ?? "open",
    labels: overrides.labels ?? ["v0.1"],
    body: overrides.body ?? "",
  };
}

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    name: overrides.name ?? "v0.1",
    issues: overrides.issues ?? [issue({ number: 1 })],
  };
}

function state(overrides: Partial<RepoState> = {}): RepoState {
  const m = overrides.milestone ?? milestone();
  return {
    ref: overrides.ref ?? { owner: "owner", repo: "repo" },
    milestone: m,
    defaultBranch: overrides.defaultBranch ?? "main",
    clawBranches: overrides.clawBranches ?? [],
    branchBehind: overrides.branchBehind ?? {},
    openPullRequests: overrides.openPullRequests ?? [],
    sessions: overrides.sessions ?? {},
  };
}

describe("runChecks — ordering", () => {
  it("returns passed when every check passes", () => {
    const result = runChecks(state());
    expect(result).toEqual({ passed: true });
  });

  it("halts on CHECK 3 when the milestone has no issues", () => {
    const result = runChecks(state({ milestone: milestone({ issues: [] }) }));
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("no issues labeled v0.1");
  });

  it("halts terminally on CHECK 4 when every issue is closed", () => {
    const result = runChecks(
      state({
        milestone: milestone({
          issues: [issue({ number: 1, state: "closed" })],
        }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.terminal).toBe(true);
  });

  it("halts on CHECK 5 before CHECK 6 when current issue is needs-human", () => {
    const result = runChecks(
      state({
        milestone: milestone({
          issues: [
            issue({ number: 1, labels: ["v0.1", NEEDS_HUMAN_LABEL] }),
          ],
        }),
        // Also set up a CHECK 6 failure — earlier-numbered check must win
        clawBranches: ["claw/a", "claw/b"],
      }),
    );
    expect(result.error?.message).toContain("needs-human");
    expect(result.error?.message).not.toContain("open claw/ branches");
  });

  it("halts on CHECK 6 before later checks when branches are ambiguous", () => {
    const result = runChecks(
      state({
        clawBranches: ["claw/a", "claw/b"],
        openPullRequests: [
          {
            number: 10,
            title: "",
            body: "",
            headRef: "claw/a",
            baseRef: "main",
            linkedIssue: null, // would trigger CHECK 7
            reviews: [],
            statusChecks: [],
          },
        ],
      }),
    );
    expect(result.error?.message).toContain("open claw/ branches");
  });

  it("halts on CHECK 9 when a branch is behind main", () => {
    const result = runChecks(
      state({
        clawBranches: ["claw/issue-1-foo"],
        openPullRequests: [
          {
            number: 10,
            title: "",
            body: "Closes #1",
            headRef: "claw/issue-1-foo",
            baseRef: "main",
            linkedIssue: 1,
            reviews: [],
            statusChecks: [],
          },
        ],
        branchBehind: { "claw/issue-1-foo": 2 },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("behind main by 2 commits");
  });
});

describe("inspectRepo", () => {
  it("builds state via `deps.buildState` and runs all checks", async () => {
    const s = state();
    const result = await inspectRepo(stubClient, "owner/repo", s.milestone, {
      buildState: async () => s,
    });
    expect(result).toEqual({ passed: true });
  });

  it("surfaces the first failing check's error", async () => {
    const s = state({ milestone: milestone({ issues: [] }) });
    const result = await inspectRepo(stubClient, "owner/repo", s.milestone, {
      buildState: async () => s,
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("no issues labeled v0.1");
  });

  it("throws a ClawError for a malformed repo string — repo parse happens first", async () => {
    await expect(
      inspectRepo(stubClient, "not-a-repo", milestone()),
    ).rejects.toThrow();
  });

  it("passes the milestone through to the state builder", async () => {
    const seen: Milestone[] = [];
    const s = state();
    await inspectRepo(stubClient, "owner/repo", s.milestone, {
      buildState: async (_client, _repo, m) => {
        seen.push(m);
        return s;
      },
    });
    expect(seen).toEqual([s.milestone]);
  });
});
