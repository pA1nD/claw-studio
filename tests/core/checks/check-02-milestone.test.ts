import { describe, expect, it } from "vitest";
import { check02Milestone } from "../../../src/core/checks/check-02-milestone.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("check02Milestone", () => {
  it("passes and returns the milestone name when one is marked", () => {
    const result = check02Milestone(
      "# Roadmap\n\n## Current milestone: v0.1 — The Loop\n",
    );
    expect(result.passed).toBe(true);
    expect(result.milestoneName).toBe("v0.1");
  });

  it("fails when no current milestone heading is present", () => {
    const result = check02Milestone("# Repo\n\n## v0.1 — The Loop\n");
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("no current milestone");
    expect(result.error?.hint).toContain("## Current milestone:");
  });

  it("fails on an empty file", () => {
    const result = check02Milestone("");
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
  });

  it("strips the trailing description from the milestone name", () => {
    const result = check02Milestone("## Current milestone: v1.2 — extra description");
    expect(result.passed).toBe(true);
    expect(result.milestoneName).toBe("v1.2");
  });
});
