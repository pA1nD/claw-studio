import { describe, expect, it } from "vitest";
import {
  buildContextPrompt,
  buildFixPrompt,
} from "../../../src/core/agents/context.js";
import type { Issue } from "../../../src/core/roadmap/parser.js";

function issue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    number: overrides.number,
    title: overrides.title ?? `Issue ${overrides.number}`,
    state: overrides.state ?? "open",
    labels: overrides.labels ?? ["v0.1"],
    body: overrides.body ?? `body ${overrides.number}`,
  };
}

describe("buildContextPrompt", () => {
  const baseInputs = {
    issue: issue({ number: 3, title: "Implementation agent" }),
    branchName: "claw/issue-3-implementation-agent",
    readme: "the readme",
    roadmap: "the roadmap",
    milestoneIssues: [
      issue({ number: 1, title: "Roadmap parser", state: "closed" }),
      issue({ number: 2, title: "State inspector", state: "closed" }),
      issue({ number: 3, title: "Implementation agent", state: "open" }),
      issue({ number: 4, title: "PR monitor", state: "open" }),
    ],
    milestoneName: "v0.1",
    priorReviewNotes: [],
  } as const;

  it("embeds the issue, README, ROADMAP and milestone name", () => {
    const prompt = buildContextPrompt(baseInputs);
    expect(prompt).toContain("issue #3");
    expect(prompt).toContain("v0.1");
    expect(prompt).toContain("--- BEGIN README.md ---");
    expect(prompt).toContain("the readme");
    expect(prompt).toContain("--- BEGIN ROADMAP.md ---");
    expect(prompt).toContain("the roadmap");
    expect(prompt).toContain("body 3");
  });

  it("names the branch the agent must commit to", () => {
    const prompt = buildContextPrompt(baseInputs);
    expect(prompt).toContain("claw/issue-3-implementation-agent");
  });

  it("partitions sibling issues into closed and open buckets, excluding the current one", () => {
    const prompt = buildContextPrompt(baseInputs);
    expect(prompt).toContain("Closed issues in this milestone");
    expect(prompt).toContain("- #1 Roadmap parser");
    expect(prompt).toContain("- #2 State inspector");
    expect(prompt).toContain("Open issues in this milestone");
    expect(prompt).toContain("- #4 PR monitor");
    // Current issue must not appear in the sibling list.
    expect(prompt.match(/- #3 Implementation agent/)).toBeNull();
  });

  it("renders `(none found)` when no prior review notes were fetched", () => {
    const prompt = buildContextPrompt(baseInputs);
    expect(prompt).toContain("--- BEGIN PRIOR REVIEW NOTES ---");
    expect(prompt).toContain("(none found)");
  });

  it("embeds prior review notes with author + URL citations", () => {
    const prompt = buildContextPrompt({
      ...baseInputs,
      priorReviewNotes: [
        {
          prNumber: 21,
          author: "claude[bot]",
          commentUrl: "https://example/c/1",
          body: "Pay attention to the session-resume path.",
        },
      ],
    });
    expect(prompt).toContain("From PR #21 (claude[bot], https://example/c/1)");
    expect(prompt).toContain("Pay attention to the session-resume path.");
  });

  it("handles an empty issue body gracefully", () => {
    const prompt = buildContextPrompt({
      ...baseInputs,
      issue: issue({ number: 3, title: "Agent", body: "   " }),
    });
    expect(prompt).toContain("(empty issue body)");
  });

  it("falls back to `(none)` when there are no sibling issues", () => {
    const prompt = buildContextPrompt({
      ...baseInputs,
      milestoneIssues: [baseInputs.issue],
    });
    expect(prompt).toContain("Closed issues in this milestone (already implemented):\n(none)");
    expect(prompt).toContain("Open issues in this milestone (still to come):\n(none)");
  });
});

describe("buildFixPrompt", () => {
  const baseIssue = issue({ number: 3, title: "Implementation agent" });

  it("lists every blocking comment in order, in full", () => {
    const prompt = buildFixPrompt({
      issue: baseIssue,
      prNumber: 42,
      attemptNumber: 1,
      reviewComments: [
        { author: "Arch", body: "arch says no" },
        { author: "Test", body: "more tests please" },
      ],
    });
    expect(prompt).toContain("PR #42");
    expect(prompt).toContain("issue #3");
    expect(prompt).toContain("fix attempt 1");
    expect(prompt).toContain("--- COMMENT 1 (by Arch) ---");
    expect(prompt).toContain("arch says no");
    expect(prompt).toContain("--- COMMENT 2 (by Test) ---");
    expect(prompt).toContain("more tests please");
  });

  it("instructs the agent not to expand scope", () => {
    const prompt = buildFixPrompt({
      issue: baseIssue,
      prNumber: 42,
      attemptNumber: 2,
      reviewComments: [],
    });
    expect(prompt).toContain("Do not expand scope");
  });

  it("mentions the expected fix commit message", () => {
    const prompt = buildFixPrompt({
      issue: baseIssue,
      prNumber: 42,
      attemptNumber: 1,
      reviewComments: [],
    });
    expect(prompt).toContain("fix: address review feedback");
  });
});
