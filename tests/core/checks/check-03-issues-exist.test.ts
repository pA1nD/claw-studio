import { describe, it, expect } from "vitest";
import { check03IssuesExist } from "../../../src/core/checks/check-03-issues-exist.js";
import type { Issue } from "../../../src/core/roadmap/parser.js";
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
  it("passes when at least one issue exists", () => {
    expect(check03IssuesExist("v0.1", [issue({ number: 1 })])).toEqual({
      passed: true,
    });
  });

  it("passes when issues are all closed — CHECK 4 handles that case", () => {
    expect(
      check03IssuesExist("v0.1", [issue({ number: 1, state: "closed" })]),
    ).toEqual({ passed: true });
  });

  it("fails when the milestone has zero issues", () => {
    const result = check03IssuesExist("v0.1", []);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("no issues labeled v0.1");
    expect(result.error?.hint).toContain("v0.1 label");
  });
});
