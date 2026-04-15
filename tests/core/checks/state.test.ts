import { describe, it, expect } from "vitest";
import type { Octokit } from "@octokit/rest";
import { buildRepoState } from "../../../src/core/checks/state.js";
import type { Milestone } from "../../../src/core/roadmap/parser.js";

const stubClient = {} as Octokit;

function mockMilestone(): Milestone {
  return {
    name: "v0.1",
    issues: [
      {
        number: 1,
        title: "First",
        state: "open",
        labels: ["v0.1"],
        body: "",
      },
    ],
  };
}

describe("buildRepoState", () => {
  it("invokes every dep exactly once and returns a RepoState", async () => {
    const calls: Record<string, number> = {};
    const track = (key: string): void => {
      calls[key] = (calls[key] ?? 0) + 1;
    };

    const state = await buildRepoState({
      client: stubClient,
      ref: { owner: "owner", repo: "repo" },
      milestone: mockMilestone(),
      cwd: "/tmp/claw-test",
      deps: {
        getDefaultBranch: async () => {
          track("getDefaultBranch");
          return "main";
        },
        listClawBranches: async () => {
          track("listClawBranches");
          return ["claw/issue-1-foo"];
        },
        listOpenPullRequests: async () => {
          track("listOpenPullRequests");
          return [
            {
              number: 10,
              title: "Test PR",
              body: "Closes #1",
              headRef: "claw/issue-1-foo",
              baseRef: "main",
              linkedIssue: 1,
              reviews: [],
              statusChecks: [],
            },
          ];
        },
        compareBranch: async (_ref, base, head) => {
          track("compareBranch");
          expect(base).toBe("main");
          expect(head).toBe("claw/issue-1-foo");
          return 0;
        },
        readSessions: async () => {
          track("readSessions");
          return {};
        },
      },
    });

    expect(state.defaultBranch).toBe("main");
    expect(state.clawBranches).toEqual(["claw/issue-1-foo"]);
    expect(state.branchBehind).toEqual({ "claw/issue-1-foo": 0 });
    expect(state.openPullRequests).toHaveLength(1);
    expect(state.sessions).toEqual({});
    expect(calls).toEqual({
      getDefaultBranch: 1,
      listClawBranches: 1,
      listOpenPullRequests: 1,
      compareBranch: 1,
      readSessions: 1,
    });
  });

  it("runs compareBranch once per claw/ branch", async () => {
    const seenHeads: string[] = [];
    const state = await buildRepoState({
      client: stubClient,
      ref: { owner: "owner", repo: "repo" },
      milestone: mockMilestone(),
      cwd: "/tmp",
      deps: {
        getDefaultBranch: async () => "main",
        listClawBranches: async () => ["claw/a", "claw/b", "claw/c"],
        listOpenPullRequests: async () => [],
        compareBranch: async (_ref, _base, head) => {
          seenHeads.push(head);
          return head === "claw/b" ? 3 : 0;
        },
        readSessions: async () => ({}),
      },
    });

    expect(seenHeads.sort()).toEqual(["claw/a", "claw/b", "claw/c"]);
    expect(state.branchBehind).toEqual({
      "claw/a": 0,
      "claw/b": 3,
      "claw/c": 0,
    });
  });

  it("propagates milestone and ref on the result", async () => {
    const milestone = mockMilestone();
    const ref = { owner: "pA1nD", repo: "claw-studio" };
    const state = await buildRepoState({
      client: stubClient,
      ref,
      milestone,
      cwd: "/tmp",
      deps: {
        getDefaultBranch: async () => "main",
        listClawBranches: async () => [],
        listOpenPullRequests: async () => [],
        compareBranch: async () => 0,
        readSessions: async () => ({}),
      },
    });
    expect(state.milestone).toBe(milestone);
    expect(state.ref).toBe(ref);
  });
});
