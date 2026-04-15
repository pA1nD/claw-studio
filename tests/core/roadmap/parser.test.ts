import { describe, it, expect } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  extractCurrentMilestone,
  parseRoadmap,
} from "../../../src/core/roadmap/parser.js";
import type { Issue } from "../../../src/core/roadmap/parser.js";
import { ClawError } from "../../../src/core/types/errors.js";

/**
 * Build an Issue with sensible defaults. Tests override only the fields that
 * matter for the assertion so the "what is being asserted" is obvious.
 */
function issue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    number: overrides.number,
    title: overrides.title ?? `Issue ${overrides.number}`,
    state: overrides.state ?? "open",
    labels: overrides.labels ?? ["v0.1"],
    body: overrides.body ?? "",
  };
}

/**
 * Stub Octokit used when deps are injected — `parseRoadmap` never touches it
 * in that path, so passing a bare cast keeps the intent readable.
 */
const stubClient = {} as Octokit;

describe("extractCurrentMilestone", () => {
  it("parses the milestone name from a standard heading", () => {
    const content = [
      "# Roadmap",
      "",
      "## Current milestone: v0.1 — The Loop",
      "",
      "## v0.1 — The Loop",
    ].join("\n");
    expect(extractCurrentMilestone(content)).toBe("v0.1");
  });

  it("returns only the first whitespace-delimited token — trailing text is ignored", () => {
    const content = "## Current milestone: v1.2 — some description";
    expect(extractCurrentMilestone(content)).toBe("v1.2");
  });

  it("accepts tabs and extra spaces around the separator", () => {
    const content = "##    Current milestone:   v0.3";
    expect(extractCurrentMilestone(content)).toBe("v0.3");
  });

  it("matches when the heading is not on the first line", () => {
    const content = [
      "# Some repo",
      "",
      "Intro text.",
      "",
      "## Current milestone: v2.0",
    ].join("\n");
    expect(extractCurrentMilestone(content)).toBe("v2.0");
  });

  it("handles CRLF line endings", () => {
    const content = "# Repo\r\n\r\n## Current milestone: v0.1 — The Loop\r\n";
    expect(extractCurrentMilestone(content)).toBe("v0.1");
  });

  it("returns null when no matching heading is present", () => {
    const content = "# Roadmap\n\n## v0.1 — The Loop\n";
    expect(extractCurrentMilestone(content)).toBeNull();
  });

  it("returns null for an empty file", () => {
    expect(extractCurrentMilestone("")).toBeNull();
  });

  it("does not match a single-hash or triple-hash heading", () => {
    expect(extractCurrentMilestone("# Current milestone: v0.1")).toBeNull();
    expect(extractCurrentMilestone("### Current milestone: v0.1")).toBeNull();
  });

  it("requires whitespace between the hashes and 'Current'", () => {
    expect(extractCurrentMilestone("##Current milestone: v0.1")).toBeNull();
  });

  it("picks the FIRST matching heading when multiple are present", () => {
    const content = [
      "## Current milestone: v0.1",
      "## Current milestone: v0.2",
    ].join("\n");
    expect(extractCurrentMilestone(content)).toBe("v0.1");
  });
});

describe("parseRoadmap", () => {
  it("returns the milestone name and issues sorted by number ascending", async () => {
    const result = await parseRoadmap(stubClient, "pA1nD/claw-studio", {
      readRoadmap: async () => "## Current milestone: v0.1 — The Loop",
      listIssuesForLabel: async () => [
        issue({ number: 7 }),
        issue({ number: 2 }),
        issue({ number: 4 }),
      ],
    });

    expect(result.name).toBe("v0.1");
    expect(result.issues.map((i) => i.number)).toEqual([2, 4, 7]);
  });

  it("passes the correct owner, repo, and label through to the deps", async () => {
    const seen: Array<{ owner: string; repo: string; label?: string }> = [];
    await parseRoadmap(stubClient, "pA1nD/claw-studio", {
      readRoadmap: async (owner, repo) => {
        seen.push({ owner, repo });
        return "## Current milestone: v0.1";
      },
      listIssuesForLabel: async (owner, repo, label) => {
        seen.push({ owner, repo, label });
        return [];
      },
    });

    expect(seen).toEqual([
      { owner: "pA1nD", repo: "claw-studio" },
      { owner: "pA1nD", repo: "claw-studio", label: "v0.1" },
    ]);
  });

  it("returns an empty issues array (not an error) when the milestone has no issues yet", async () => {
    const result = await parseRoadmap(stubClient, "owner/repo", {
      readRoadmap: async () => "## Current milestone: v0.1",
      listIssuesForLabel: async () => [],
    });
    expect(result).toEqual({ name: "v0.1", issues: [] });
  });

  it("preserves open vs closed state on each issue", async () => {
    const result = await parseRoadmap(stubClient, "owner/repo", {
      readRoadmap: async () => "## Current milestone: v0.1",
      listIssuesForLabel: async () => [
        issue({ number: 1, state: "open" }),
        issue({ number: 2, state: "closed" }),
        issue({ number: 3, state: "open" }),
      ],
    });

    expect(result.issues.map((i) => [i.number, i.state])).toEqual([
      [1, "open"],
      [2, "closed"],
      [3, "open"],
    ]);
  });

  it("preserves title, labels, and body verbatim for each issue", async () => {
    const result = await parseRoadmap(stubClient, "owner/repo", {
      readRoadmap: async () => "## Current milestone: v0.1",
      listIssuesForLabel: async () => [
        issue({
          number: 1,
          title: "Roadmap parser",
          labels: ["v0.1", "enhancement"],
          body: "## What\n\nParse ROADMAP.md...",
        }),
      ],
    });

    expect(result.issues).toEqual([
      {
        number: 1,
        title: "Roadmap parser",
        state: "open",
        labels: ["v0.1", "enhancement"],
        body: "## What\n\nParse ROADMAP.md...",
      },
    ]);
  });

  it("throws a ClawError when ROADMAP.md does not exist", async () => {
    const error = await parseRoadmap(stubClient, "owner/repo", {
      readRoadmap: async () => null,
      listIssuesForLabel: async () => [],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    const clawError = error as ClawError;
    expect(clawError.message).toContain("no ROADMAP.md found in owner/repo");
    expect(clawError.hint).toContain("Add a ROADMAP.md");
  });

  it("does not fetch issues when ROADMAP.md is missing", async () => {
    let listCalled = false;
    await parseRoadmap(stubClient, "owner/repo", {
      readRoadmap: async () => null,
      listIssuesForLabel: async () => {
        listCalled = true;
        return [];
      },
    }).catch(() => {
      /* expected */
    });

    expect(listCalled).toBe(false);
  });

  it("throws a ClawError when no current milestone line is present", async () => {
    const error = await parseRoadmap(stubClient, "owner/repo", {
      readRoadmap: async () => "# Repo\n\n## v0.1 — The Loop\n",
      listIssuesForLabel: async () => [],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    const clawError = error as ClawError;
    expect(clawError.message).toContain("no current milestone");
    expect(clawError.hint).toContain("## Current milestone:");
  });

  it("does not fetch issues when no current milestone is marked", async () => {
    let listCalled = false;
    await parseRoadmap(stubClient, "owner/repo", {
      readRoadmap: async () => "# Nothing useful here",
      listIssuesForLabel: async () => {
        listCalled = true;
        return [];
      },
    }).catch(() => {
      /* expected */
    });

    expect(listCalled).toBe(false);
  });

  it("throws a ClawError when the repo string is malformed", async () => {
    await expect(
      parseRoadmap(stubClient, "not-a-repo", {
        readRoadmap: async () => "## Current milestone: v0.1",
        listIssuesForLabel: async () => [],
      }),
    ).rejects.toBeInstanceOf(ClawError);
  });

  it("re-throws errors from the readRoadmap dep other than not-found", async () => {
    const error = await parseRoadmap(stubClient, "owner/repo", {
      readRoadmap: async () => {
        throw new Error("rate limit exceeded");
      },
      listIssuesForLabel: async () => [],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("rate limit exceeded");
  });

  it("extracts the name from a heading that contains a trailing description", async () => {
    const result = await parseRoadmap(stubClient, "owner/repo", {
      readRoadmap: async () => "## Current milestone: v0.1 — The Loop\n",
      listIssuesForLabel: async (_owner, _repo, label) => {
        // The label we pass to the API must be just "v0.1", not the whole line.
        expect(label).toBe("v0.1");
        return [issue({ number: 1 })];
      },
    });

    expect(result.name).toBe("v0.1");
  });
});
