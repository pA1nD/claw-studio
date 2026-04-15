import { describe, expect, it } from "vitest";
import { check03IssuesExist } from "../../../src/core/checks/check-03-issues-exist.js";
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

describe("check03IssuesExist", () => {
  it("passes when at least one issue exists for the milestone", () => {
    const milestone: Milestone = { name: "v0.1", issues: [issue({ number: 1 })] };
    expect(check03IssuesExist(milestone)).toEqual({ passed: true });
  });

  it("passes when only closed issues exist (CHECK 4 catches that)", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [issue({ number: 1, state: "closed" })],
    };
    expect(check03IssuesExist(milestone).passed).toBe(true);
  });

  it("fails when no issues exist", () => {
    const milestone: Milestone = { name: "v0.1", issues: [] };
    const result = check03IssuesExist(milestone);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("no issues labeled v0.1");
    expect(result.error?.hint).toContain("Create GitHub issues labeled v0.1");
  });
});
