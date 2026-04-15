import { describe, it, expect } from "vitest";
import { check04AllIssuesClosed } from "../../../src/core/checks/check-04-all-issues-closed.js";
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

describe("check04AllIssuesClosed", () => {
  it("passes when at least one issue is open", () => {
    const result = check04AllIssuesClosed("v0.1", [
      issue({ number: 1, state: "closed" }),
      issue({ number: 2, state: "open" }),
    ]);
    expect(result).toEqual({ passed: true });
  });

  it("passes when the issues array is empty — CHECK 3 owns that failure", () => {
    expect(check04AllIssuesClosed("v0.1", [])).toEqual({ passed: true });
  });

  it("fails terminally when every issue is closed", () => {
    const result = check04AllIssuesClosed("v0.1", [
      issue({ number: 1, state: "closed" }),
      issue({ number: 2, state: "closed" }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("every v0.1 issue is closed");
    expect(result.error?.hint).toContain("next milestone");
  });
});
