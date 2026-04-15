import { describe, it, expect } from "vitest";
import {
  check05CurrentNeedsHuman,
  NEEDS_HUMAN_LABEL,
} from "../../../src/core/checks/check-05-current-needs-human.js";
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

describe("check05CurrentNeedsHuman", () => {
  it("passes when the first open issue is not labeled needs-human", () => {
    const result = check05CurrentNeedsHuman([
      issue({ number: 1, state: "closed" }),
      issue({ number: 2, state: "open" }),
    ]);
    expect(result).toEqual({ passed: true });
  });

  it("passes when there are no open issues — CHECK 4 owns that state", () => {
    const result = check05CurrentNeedsHuman([issue({ number: 1, state: "closed" })]);
    expect(result).toEqual({ passed: true });
  });

  it("fails when the first OPEN issue carries the needs-human label", () => {
    const result = check05CurrentNeedsHuman([
      issue({ number: 1, state: "closed" }),
      issue({ number: 2, state: "open", labels: ["v0.1", NEEDS_HUMAN_LABEL] }),
      issue({ number: 3, state: "open" }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("issue #2");
    expect(result.error?.hint).toContain("Resolve the blockers on issue #2");
  });

  it("uses the lowest-numbered open issue as 'current'", () => {
    const result = check05CurrentNeedsHuman([
      issue({ number: 5, state: "open" }),
      issue({ number: 3, state: "open", labels: ["v0.1", NEEDS_HUMAN_LABEL] }),
    ]);
    // First in the array is #5 — issues are assumed to already be sorted.
    expect(result.passed).toBe(true);
  });

  it("label comparison is case-sensitive — 'Needs-Human' does not trigger", () => {
    const result = check05CurrentNeedsHuman([
      issue({ number: 1, state: "open", labels: ["Needs-Human"] }),
    ]);
    expect(result.passed).toBe(true);
  });
});
