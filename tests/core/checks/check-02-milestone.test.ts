import { describe, it, expect } from "vitest";
import { check02Milestone } from "../../../src/core/checks/check-02-milestone.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("check02Milestone", () => {
  it("passes when a non-empty milestone name is given", () => {
    expect(check02Milestone("v0.1")).toEqual({ passed: true });
  });

  it("fails when the milestone name is null", () => {
    const result = check02Milestone(null);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("no current milestone");
    expect(result.error?.hint).toContain("## Current milestone:");
  });

  it("fails when the milestone name is an empty string", () => {
    const result = check02Milestone("");
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
  });

  it("fails when the milestone name is whitespace only", () => {
    const result = check02Milestone("   ");
    expect(result.passed).toBe(false);
  });
});
