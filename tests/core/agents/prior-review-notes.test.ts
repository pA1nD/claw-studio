import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  buildStandaloneReferenceRegex,
  extractCrossReferencedPRNumber,
  fetchPriorReviewNotes,
} from "../../../src/core/agents/prior-review-notes.js";
import type { RawComment } from "../../../src/core/agents/prior-review-notes.js";

const ref = { owner: "pA1nD", repo: "claw-studio" };
const stubClient = {} as Octokit;

describe("buildStandaloneReferenceRegex", () => {
  it("matches a standalone reference at the start of a line", () => {
    const re = buildStandaloneReferenceRegex(3);
    expect(re.test("#3 should import from types.ts")).toBe(true);
  });

  it("matches references inside a sentence", () => {
    const re = buildStandaloneReferenceRegex(3);
    expect(re.test("the state inspector (issue #3) should move")).toBe(true);
  });

  it("does not match when followed by more digits", () => {
    const re = buildStandaloneReferenceRegex(3);
    expect(re.test("see #35 for context")).toBe(false);
  });

  it("does not match when preceded by a word character", () => {
    const re = buildStandaloneReferenceRegex(3);
    expect(re.test("foo#3 should be tested")).toBe(false);
  });

  it("does not match when preceded by another `#` (markdown heading)", () => {
    const re = buildStandaloneReferenceRegex(3);
    expect(re.test("##3 as a heading")).toBe(false);
  });

  it("matches across different issue numbers", () => {
    expect(buildStandaloneReferenceRegex(42).test("done in #42.")).toBe(true);
    expect(buildStandaloneReferenceRegex(42).test("PR #142")).toBe(false);
  });
});

describe("extractCrossReferencedPRNumber", () => {
  it("returns the PR number for a cross-referenced PR event", () => {
    const event = {
      event: "cross-referenced",
      source: {
        issue: { number: 25, pull_request: { merged_at: "2026-04-15..." } },
      },
    };
    expect(extractCrossReferencedPRNumber(event)).toBe(25);
  });

  it("returns null for non-cross-referenced events", () => {
    const event = {
      event: "labeled",
      source: { issue: { number: 25, pull_request: {} } },
    };
    expect(extractCrossReferencedPRNumber(event)).toBeNull();
  });

  it("returns null when the source is an issue, not a PR", () => {
    const event = {
      event: "cross-referenced",
      source: { issue: { number: 25 } }, // no pull_request field
    };
    expect(extractCrossReferencedPRNumber(event)).toBeNull();
  });

  it("returns null for malformed payloads", () => {
    expect(extractCrossReferencedPRNumber(null)).toBeNull();
    expect(extractCrossReferencedPRNumber("nope")).toBeNull();
    expect(extractCrossReferencedPRNumber({})).toBeNull();
    expect(extractCrossReferencedPRNumber({ event: "cross-referenced" })).toBeNull();
  });
});

describe("fetchPriorReviewNotes", () => {
  function comment(overrides: Partial<RawComment> & { body: string }): RawComment {
    return {
      body: overrides.body,
      author: overrides.author ?? "claude[bot]",
      url: overrides.url ?? "https://example/c/1",
    };
  }

  it("returns an empty list when no merged PRs cross-reference the issue", async () => {
    const listCrossReferencedMergedPRs = vi.fn(async () => []);
    const listPRComments = vi.fn(async () => [] as RawComment[]);

    const notes = await fetchPriorReviewNotes(stubClient, ref, 3, {
      listCrossReferencedMergedPRs,
      listPRComments,
    });

    expect(notes).toEqual([]);
    expect(listPRComments).not.toHaveBeenCalled();
  });

  it("returns only comments that contain a standalone #N reference", async () => {
    const commentsByPr: Record<number, RawComment[]> = {
      21: [
        comment({ body: "mentions #3 and is relevant" }),
        comment({ body: "mentions #35 which is unrelated" }),
      ],
    };
    const listCrossReferencedMergedPRs = vi.fn(async () => [21]);
    const listPRComments = vi.fn(async (_: typeof ref, pr: number) => commentsByPr[pr] ?? []);

    const notes = await fetchPriorReviewNotes(stubClient, ref, 3, {
      listCrossReferencedMergedPRs,
      listPRComments,
    });

    expect(notes.map((n) => n.body)).toEqual(["mentions #3 and is relevant"]);
    expect(notes[0]?.prNumber).toBe(21);
  });

  it("preserves order across multiple PRs (by PR number)", async () => {
    const listCrossReferencedMergedPRs = vi.fn(async () => [7, 12]);
    const listPRComments = vi.fn(async (_: typeof ref, pr: number) => [
      comment({ body: `pr ${pr}: note about #3` }),
    ]);

    const notes = await fetchPriorReviewNotes(stubClient, ref, 3, {
      listCrossReferencedMergedPRs,
      listPRComments,
    });

    expect(notes.map((n) => n.prNumber)).toEqual([7, 12]);
  });

  it("carries through author and URL for citation", async () => {
    const listCrossReferencedMergedPRs = vi.fn(async () => [1]);
    const listPRComments = vi.fn(async () => [
      comment({
        body: "review of #3",
        author: "review-bot",
        url: "https://github.com/owner/repo/pull/1#issuecomment-123",
      }),
    ]);

    const notes = await fetchPriorReviewNotes(stubClient, ref, 3, {
      listCrossReferencedMergedPRs,
      listPRComments,
    });

    expect(notes).toEqual([
      {
        prNumber: 1,
        author: "review-bot",
        commentUrl: "https://github.com/owner/repo/pull/1#issuecomment-123",
        body: "review of #3",
      },
    ]);
  });
});
