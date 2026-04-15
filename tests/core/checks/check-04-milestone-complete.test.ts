import { describe, expect, it } from "vitest";
import { check04MilestoneComplete } from "../../../src/core/checks/check-04-milestone-complete.js";
import type { Issue, Milestone } from "../../../src/core/roadmap/parser.js";
import { ClawError } from "../../../src/core/types/errors.js";

function issue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    number: overrides.number,
    title: overrides.title ?? `Issue ${overrides.number}`,
    state: overrides.state ?? "open",
    labels: overrides.labels ?? ["v0.1"],
    body: overrides.body ?? "",
  };
}

describe("check04MilestoneComplete", () => {
  it("passes when at least one issue is still open", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [
        issue({ number: 1, state: "closed" }),
        issue({ number: 2, state: "open" }),
      ],
    };
    expect(check04MilestoneComplete(milestone).passed).toBe(true);
  });

  it("returns a terminal failure when every issue is closed", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [
        issue({ number: 1, state: "closed" }),
        issue({ number: 2, state: "closed" }),
      ],
    };
    const result = check04MilestoneComplete(milestone);
    expect(result.passed).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("all v0.1 issues are closed");
    expect(result.error?.hint).toContain("Update ROADMAP.md");
  });
});
