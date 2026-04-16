import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  CHANGES_REQUESTED_MARKER,
  fetchBlockingReviewComments,
  isReviewAgentComment,
  isReviewSummaryComment,
  type FetchReviewCommentsDeps,
  type RawPRComment,
} from "../../../src/core/loop/review-comments.js";
import {
  REVIEW_SUMMARY_HEADER,
} from "../../../src/core/agents/pr-monitor.js";
import { ClawError } from "../../../src/core/types/errors.js";

const stubClient = {} as Octokit;
const REPO = "pA1nD/claw-studio";
const PR = 42;

/** Build a deps object whose `listPRComments` returns the supplied comments. */
function deps(comments: RawPRComment[]): FetchReviewCommentsDeps {
  return {
    listPRComments: vi.fn(async () => comments),
  };
}

describe("isReviewAgentComment", () => {
  it("matches each of the five agent headers as a prefix", () => {
    expect(isReviewAgentComment("## Arch Review\nverdict")).toBe(true);
    expect(isReviewAgentComment("## DX Review\nx")).toBe(true);
    expect(isReviewAgentComment("## Security Review\nx")).toBe(true);
    expect(isReviewAgentComment("## Perf Review\nx")).toBe(true);
    expect(isReviewAgentComment("## Test Review\nx")).toBe(true);
  });

  it("tolerates leading whitespace", () => {
    expect(isReviewAgentComment("\n  \n## Arch Review")).toBe(true);
  });

  it("rejects non-review prefixes", () => {
    expect(isReviewAgentComment("Not a review")).toBe(false);
    expect(isReviewAgentComment("# Arch Review")).toBe(false);
    expect(isReviewAgentComment("")).toBe(false);
  });
});

describe("isReviewSummaryComment", () => {
  it("matches the summary header as a prefix", () => {
    expect(isReviewSummaryComment(`${REVIEW_SUMMARY_HEADER}\nrest`)).toBe(true);
  });

  it("tolerates leading whitespace", () => {
    expect(isReviewSummaryComment(`  ${REVIEW_SUMMARY_HEADER}`)).toBe(true);
  });

  it("rejects non-summary prefixes", () => {
    expect(isReviewSummaryComment("## Arch Review")).toBe(false);
    expect(isReviewSummaryComment("")).toBe(false);
  });
});

describe("fetchBlockingReviewComments", () => {
  it("returns only review-agent comments that contain the changes-requested marker", async () => {
    const blocking: RawPRComment = {
      author: "claude[bot]",
      body: `## Arch Review\n\n${CHANGES_REQUESTED_MARKER} — fix this please.`,
    };
    const approved: RawPRComment = {
      author: "claude[bot]",
      body: "## DX Review\n\nAPPROVED — looks good.",
    };
    const summary: RawPRComment = {
      author: "claude[bot]",
      body: `${REVIEW_SUMMARY_HEADER}\n\nAll fine.`,
    };
    const drive: RawPRComment = {
      author: "human",
      body: `Random comment with ${CHANGES_REQUESTED_MARKER}`,
    };

    const result = await fetchBlockingReviewComments(
      stubClient,
      REPO,
      PR,
      deps([blocking, approved, summary, drive]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.body).toContain("## Arch Review");
    expect(result[0]?.author).toBe("claude[bot]");
  });

  it("excludes the Review Summary even when it lists blocking issues", async () => {
    const summary: RawPRComment = {
      author: "claude[bot]",
      body: [
        REVIEW_SUMMARY_HEADER,
        "",
        `${CHANGES_REQUESTED_MARKER} per Arch.`,
      ].join("\n"),
    };
    const result = await fetchBlockingReviewComments(
      stubClient,
      REPO,
      PR,
      deps([summary]),
    );
    expect(result).toEqual([]);
  });

  it("preserves chronological order across multiple blocking comments", async () => {
    const a: RawPRComment = {
      author: "claude[bot]",
      body: `## Arch Review\n${CHANGES_REQUESTED_MARKER}\nA`,
    };
    const b: RawPRComment = {
      author: "claude[bot]",
      body: `## DX Review\n${CHANGES_REQUESTED_MARKER}\nB`,
    };
    const result = await fetchBlockingReviewComments(
      stubClient,
      REPO,
      PR,
      deps([a, b]),
    );
    expect(result.map((c) => c.body)).toEqual([a.body, b.body]);
  });

  it("returns an empty array when no comments match", async () => {
    const result = await fetchBlockingReviewComments(
      stubClient,
      REPO,
      PR,
      deps([]),
    );
    expect(result).toEqual([]);
  });

  it("rejects an invalid repo string before any API call", async () => {
    const seam = vi.fn(async () => []);
    await expect(
      fetchBlockingReviewComments(stubClient, "not a repo", PR, {
        listPRComments: seam,
      }),
    ).rejects.toBeInstanceOf(ClawError);
    expect(seam).not.toHaveBeenCalled();
  });

  it("translates a 429 from listPRComments into the standard rate-limit error", async () => {
    const rateLimited: FetchReviewCommentsDeps = {
      listPRComments: async () => {
        const err: { status: number; response: { headers: Record<string, string> } } = {
          status: 429,
          response: { headers: { "x-ratelimit-reset": "1700000000" } },
        };
        throw err;
      },
    };
    await expect(
      fetchBlockingReviewComments(stubClient, REPO, PR, rateLimited),
    ).rejects.toThrow(ClawError);
    await expect(
      fetchBlockingReviewComments(stubClient, REPO, PR, rateLimited),
    ).rejects.toThrow("GitHub API rate limit reached.");
  });

  it("propagates non-rate-limit errors unchanged", async () => {
    const err = new Error("network down");
    const failing: FetchReviewCommentsDeps = {
      listPRComments: async () => {
        throw err;
      },
    };
    await expect(
      fetchBlockingReviewComments(stubClient, REPO, PR, failing),
    ).rejects.toBe(err);
  });
});
