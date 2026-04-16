import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { ClawError } from "../../src/core/types/errors.js";
import {
  closeIterationIssues,
  closeOpenPullRequests,
  computeNextRunId,
  copyTemplateIssues,
  countIssueStates,
  deleteClawBranches,
  ensureRunLabel,
  forceUpdateBranch,
  listLabelNames,
  listTemplateIssues,
  postTrackingComment,
  readIterationIssues,
  resolveTagSha,
  rewriteCurrentMilestone,
  updateCurrentMilestoneLine,
} from "../../benchmark/github.js";

// The Octokit surface we actually use is tiny; a structural stub keeps
// type gymnastics to a minimum. `paginate` here is the identity for
// whatever inner call returns an array, which mirrors Octokit's shape.
interface OctokitStub {
  paginate: (
    method: (...args: unknown[]) => Promise<{ data: unknown[] }>,
    params?: Record<string, unknown>,
  ) => Promise<unknown[]>;
  issues: Record<string, (...args: unknown[]) => Promise<unknown>>;
  git: Record<string, (...args: unknown[]) => Promise<unknown>>;
  repos: Record<string, (...args: unknown[]) => Promise<unknown>>;
  pulls: Record<string, (...args: unknown[]) => Promise<unknown>>;
}

/** Build an Octokit stub with `paginate` that delegates to the wrapped method. */
function makeOctokit(overrides: Partial<OctokitStub>): Octokit {
  const stub: OctokitStub = {
    paginate: vi.fn(async (method, params) => {
      const result = await method(params);
      return Array.isArray(result) ? result : (result as { data: unknown[] }).data;
    }),
    issues: {},
    git: {},
    repos: {},
    pulls: {},
    ...overrides,
  };
  return stub as unknown as Octokit;
}

const REF = { owner: "pA1nD", repo: "claw-e2e-mdcast" };

describe("computeNextRunId", () => {
  it("mints the first iteration on a fresh repo", () => {
    expect(computeNextRunId("v0.1", [])).toEqual({
      milestone: "v0.1",
      iteration: 1,
      label: "v0.1-001",
    });
  });

  it("increments past the current max", () => {
    expect(
      computeNextRunId("v0.1", ["v0.1-001", "v0.1-002", "v0.1-007", "unrelated"]),
    ).toEqual({ milestone: "v0.1", iteration: 8, label: "v0.1-008" });
  });

  it("zero-pads to 3 digits", () => {
    const { label } = computeNextRunId("v0.2", ["v0.2-009"]);
    expect(label).toBe("v0.2-010");
  });

  it("escapes regex metacharacters in the milestone", () => {
    expect(
      computeNextRunId("v0.1.0", ["v0X1Y0-001", "v0.1.0-005"]).label,
    ).toBe("v0.1.0-006");
  });

  it("ignores malformed labels that don't match {milestone}-{digits}", () => {
    expect(
      computeNextRunId("v0.1", ["v0.1", "v0.1-", "v0.1-abc", "v0.1-01-extra"]),
    ).toEqual({ milestone: "v0.1", iteration: 1, label: "v0.1-001" });
  });
});

describe("listLabelNames", () => {
  it("paginates and extracts names", async () => {
    const octokit = makeOctokit({
      issues: {
        listLabelsForRepo: vi.fn(async () => ({
          data: [{ name: "v0.1" }, { name: "v0.1-001" }, { name: "needs-human" }],
        })),
      },
    });
    const names = await listLabelNames(octokit, REF);
    expect(names).toEqual(["v0.1", "v0.1-001", "needs-human"]);
  });
});

describe("ensureRunLabel", () => {
  it("creates a new label", async () => {
    const createLabel = vi.fn(async () => ({ data: {} }));
    const octokit = makeOctokit({ issues: { createLabel } });
    await ensureRunLabel(octokit, REF, "v0.1-001");
    expect(createLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "pA1nD",
        repo: "claw-e2e-mdcast",
        name: "v0.1-001",
      }),
    );
  });

  it("swallows a 422 'already exists' response", async () => {
    const err: Error & { status?: number } = new Error("already exists");
    err.status = 422;
    const createLabel = vi.fn(async () => {
      throw err;
    });
    const octokit = makeOctokit({ issues: { createLabel } });
    await expect(ensureRunLabel(octokit, REF, "v0.1-001")).resolves.toBeUndefined();
  });

  it("surfaces non-422 errors as ClawError", async () => {
    const err: Error & { status?: number } = new Error("auth failed");
    err.status = 401;
    const createLabel = vi.fn(async () => {
      throw err;
    });
    const octokit = makeOctokit({ issues: { createLabel } });
    await expect(ensureRunLabel(octokit, REF, "v0.1-001")).rejects.toBeInstanceOf(
      ClawError,
    );
  });
});

describe("forceUpdateBranch", () => {
  it("calls git.updateRef with force=true", async () => {
    const updateRef = vi.fn(async () => ({ data: {} }));
    const octokit = makeOctokit({ git: { updateRef } });
    await forceUpdateBranch(octokit, REF, "main", "c850fc5d088a0efca73c1d6038ac55d426e39b30");
    expect(updateRef).toHaveBeenCalledWith({
      owner: "pA1nD",
      repo: "claw-e2e-mdcast",
      ref: "heads/main",
      sha: "c850fc5d088a0efca73c1d6038ac55d426e39b30",
      force: true,
    });
  });
});

describe("resolveTagSha", () => {
  it("returns the commit SHA for a lightweight tag", async () => {
    const getRef = vi.fn(async () => ({
      data: { object: { type: "commit", sha: "abc123" } },
    }));
    const octokit = makeOctokit({ git: { getRef } });
    const sha = await resolveTagSha(octokit, REF, "initial");
    expect(sha).toBe("abc123");
  });

  it("follows one indirection for an annotated tag", async () => {
    const getRef = vi.fn(async () => ({
      data: { object: { type: "tag", sha: "tag_obj_sha" } },
    }));
    const getTag = vi.fn(async () => ({
      data: { object: { sha: "commit_sha" } },
    }));
    const octokit = makeOctokit({ git: { getRef, getTag } });
    const sha = await resolveTagSha(octokit, REF, "initial");
    expect(sha).toBe("commit_sha");
    expect(getTag).toHaveBeenCalledWith({
      owner: "pA1nD",
      repo: "claw-e2e-mdcast",
      tag_sha: "tag_obj_sha",
    });
  });
});

describe("listTemplateIssues", () => {
  it("returns issues in ascending number order, skipping PRs", async () => {
    const listForRepo = vi.fn(async () => ({
      data: [
        { number: 3, title: "Parser", body: "body 3", pull_request: undefined },
        { number: 1, title: "Scaffold", body: "body 1", pull_request: undefined },
        { number: 2, title: "CLI", body: "body 2", pull_request: undefined },
        {
          number: 999,
          title: "not an issue",
          body: "PR",
          pull_request: { url: "..." },
        },
      ],
    }));
    const octokit = makeOctokit({ issues: { listForRepo } });
    const issues = await listTemplateIssues(octokit, REF);
    expect(issues.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(issues[0]!.title).toBe("Scaffold");
  });
});

describe("copyTemplateIssues", () => {
  it("creates one issue per template and carries only the iteration label", async () => {
    const create = vi.fn(async (params: unknown) => {
      const p = params as { title: string };
      return { data: { number: 100 + Math.floor(Math.random() * 1000), title: p.title } };
    });
    const octokit = makeOctokit({ issues: { create } });

    const templates = [
      { number: 1, title: "Scaffold", body: "b1" },
      { number: 2, title: "CLI", body: "b2" },
    ];
    const copies = await copyTemplateIssues(octokit, REF, templates, "v0.1-001");
    expect(copies).toHaveLength(2);
    expect(copies[0]!.template).toBe(1);
    expect(copies[1]!.template).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, {
      owner: "pA1nD",
      repo: "claw-e2e-mdcast",
      title: "Scaffold",
      body: "b1",
      labels: ["v0.1-001"],
    });
  });
});

describe("rewriteCurrentMilestone", () => {
  it("replaces the existing current-milestone line", () => {
    const before = `# Roadmap

## Current milestone: v0.1

Body`;
    const after = rewriteCurrentMilestone(before, "v0.1-001");
    expect(after).toContain("## Current milestone: v0.1-001");
    expect(after).not.toContain("## Current milestone: v0.1\n");
  });

  it("handles whitespace variations", () => {
    const before = `##    Current   milestone:    v0.2\nBody`;
    expect(rewriteCurrentMilestone(before, "v0.1-001")).toBe(
      "## Current milestone: v0.1-001\nBody",
    );
  });

  it("prepends when no existing line is present", () => {
    const before = `# Plain roadmap with no marker\nBody`;
    expect(rewriteCurrentMilestone(before, "v0.1-001")).toBe(
      `## Current milestone: v0.1-001\n\n# Plain roadmap with no marker\nBody`,
    );
  });

  it("returns input unchanged when nothing would change", () => {
    const before = `## Current milestone: v0.1-001\nBody`;
    expect(rewriteCurrentMilestone(before, "v0.1-001")).toBe(before);
  });
});

describe("updateCurrentMilestoneLine", () => {
  it("commits the rewritten ROADMAP via createOrUpdateFileContents", async () => {
    const rawContent = `# Roadmap\n\n## Current milestone: v0.1\n`;
    const base64 = Buffer.from(rawContent, "utf8").toString("base64");
    const getContent = vi.fn(async () => ({
      data: { content: base64, encoding: "base64", sha: "blob_sha" },
    }));
    const createOrUpdateFileContents = vi.fn(async () => ({
      data: { commit: { sha: "new_commit_sha" } },
    }));
    const octokit = makeOctokit({
      repos: { getContent, createOrUpdateFileContents },
    });

    const result = await updateCurrentMilestoneLine(octokit, REF, "v0.1-001");
    expect(result).toBe("new_commit_sha");
    expect(createOrUpdateFileContents).toHaveBeenCalledTimes(1);
    const call = createOrUpdateFileContents.mock.calls[0]?.[0] as {
      content: string;
      message: string;
      sha: string;
    };
    const decoded = Buffer.from(call.content, "base64").toString("utf8");
    expect(decoded).toContain("## Current milestone: v0.1-001");
    expect(call.sha).toBe("blob_sha");
    expect(call.message).toContain("v0.1-001");
  });

  it("returns null when no change is needed (idempotent)", async () => {
    const rawContent = `## Current milestone: v0.1-001\n`;
    const base64 = Buffer.from(rawContent, "utf8").toString("base64");
    const getContent = vi.fn(async () => ({
      data: { content: base64, encoding: "base64", sha: "blob_sha" },
    }));
    const createOrUpdateFileContents = vi.fn();
    const octokit = makeOctokit({
      repos: { getContent, createOrUpdateFileContents },
    });

    const result = await updateCurrentMilestoneLine(octokit, REF, "v0.1-001");
    expect(result).toBeNull();
    expect(createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("halts with a ClawError on a malformed getContent response", async () => {
    const getContent = vi.fn(async () => ({ data: [] }));
    const octokit = makeOctokit({ repos: { getContent } });
    await expect(
      updateCurrentMilestoneLine(octokit, REF, "v0.1-001"),
    ).rejects.toBeInstanceOf(ClawError);
  });
});

describe("countIssueStates", () => {
  it("counts open + closed + escalated", async () => {
    const listForRepo = vi.fn(async () => ({
      data: [
        { number: 1, state: "closed", labels: [{ name: "v0.1-001" }] },
        { number: 2, state: "open", labels: [{ name: "v0.1-001" }] },
        {
          number: 3,
          state: "closed",
          labels: [{ name: "v0.1-001" }, { name: "needs-human" }],
        },
        {
          number: 99,
          state: "open",
          labels: [],
          pull_request: { url: "..." },
        },
      ],
    }));
    const octokit = makeOctokit({ issues: { listForRepo } });
    const states = await countIssueStates(octokit, REF, "v0.1-001");
    expect(states).toEqual({ open: 1, closed: 2, escalated: 1 });
  });
});

describe("readIterationIssues", () => {
  it("projects full per-issue rows and strips PR entries", async () => {
    const listForRepo = vi.fn(async () => ({
      data: [
        {
          number: 10,
          title: "A",
          state: "closed",
          labels: [{ name: "v0.1-001" }],
        },
        {
          number: 11,
          title: "B",
          state: "open",
          labels: [{ name: "v0.1-001" }, { name: "needs-human" }],
        },
        {
          number: 99,
          title: "pr",
          state: "open",
          labels: [],
          pull_request: { url: "..." },
        },
      ],
    }));
    const octokit = makeOctokit({ issues: { listForRepo } });
    const rows = await readIterationIssues(octokit, REF, "v0.1-001");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      number: 10,
      title: "A",
      state: "closed",
      labels: ["v0.1-001"],
    });
    expect(rows[1]?.labels).toContain("needs-human");
  });
});

describe("closeOpenPullRequests", () => {
  it("closes every open PR and returns the numbers", async () => {
    const list = vi.fn(async () => ({
      data: [{ number: 42 }, { number: 43 }],
    }));
    const update = vi.fn(async () => ({ data: {} }));
    const octokit = makeOctokit({ pulls: { list, update } });

    const closed = await closeOpenPullRequests(octokit, REF);
    expect(closed).toEqual([42, 43]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, {
      owner: "pA1nD",
      repo: "claw-e2e-mdcast",
      pull_number: 42,
      state: "closed",
    });
  });
});

describe("closeIterationIssues", () => {
  it("closes only issues (skipping PRs in the listing)", async () => {
    const listForRepo = vi.fn(async () => ({
      data: [
        { number: 1, labels: [{ name: "v0.1-001" }] },
        { number: 2, labels: [{ name: "v0.1-001" }], pull_request: { url: "..." } },
        { number: 3, labels: [{ name: "v0.1-001" }] },
      ],
    }));
    const update = vi.fn(async () => ({ data: {} }));
    const octokit = makeOctokit({ issues: { listForRepo, update } });
    const closed = await closeIterationIssues(octokit, REF, "v0.1-001");
    expect(closed).toEqual([1, 3]);
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe("deleteClawBranches", () => {
  it("deletes every claw/ branch and refuses anything else", async () => {
    const listMatchingRefs = vi.fn(async () => ({
      data: [
        { ref: "refs/heads/claw/issue-1-scaffold" },
        { ref: "refs/heads/claw/issue-2-cli" },
        // Defensive: force a non-matching entry to verify the safety guard
        { ref: "refs/heads/feature/unrelated" },
      ],
    }));
    const deleteRef = vi.fn(async () => ({ data: {} }));
    const octokit = makeOctokit({ git: { listMatchingRefs, deleteRef } });
    const deleted = await deleteClawBranches(octokit, REF);
    expect(deleted).toEqual(["claw/issue-1-scaffold", "claw/issue-2-cli"]);
    expect(deleteRef).toHaveBeenCalledTimes(2);
    expect(deleteRef).toHaveBeenNthCalledWith(1, {
      owner: "pA1nD",
      repo: "claw-e2e-mdcast",
      ref: "heads/claw/issue-1-scaffold",
    });
  });
});

describe("postTrackingComment", () => {
  it("creates a comment and returns its id", async () => {
    const createComment = vi.fn(async () => ({ data: { id: 555 } }));
    const octokit = makeOctokit({ issues: { createComment } });
    const id = await postTrackingComment(octokit, REF, 10, "body");
    expect(id).toBe(555);
    expect(createComment).toHaveBeenCalledWith({
      owner: "pA1nD",
      repo: "claw-e2e-mdcast",
      issue_number: 10,
      body: "body",
    });
  });

  it("wraps failures into ClawError with context", async () => {
    const createComment = vi.fn(async () => {
      throw new Error("network down");
    });
    const octokit = makeOctokit({ issues: { createComment } });
    await expect(postTrackingComment(octokit, REF, 10, "body")).rejects.toBeInstanceOf(
      ClawError,
    );
  });
});
