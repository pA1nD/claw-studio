import { describe, expect, it } from "vitest";
import {
  BRANCH_SLUG_MAX_LENGTH,
  branchName,
  slugify,
} from "../../../src/core/agents/branch-name.js";

describe("branchName", () => {
  it("prefixes with claw/ and embeds the issue number", () => {
    expect(branchName(3, "Implementation agent")).toBe(
      "claw/issue-3-implementation-agent",
    );
  });

  it("slugifies titles with punctuation and mixed case", () => {
    expect(branchName(12, "Fix: the PR monitor!!! (part 2)")).toBe(
      "claw/issue-12-fix-the-pr-monitor-part-2",
    );
  });

  it("falls back to `issue` when the title has no alphanumerics", () => {
    expect(branchName(99, "!!! ???")).toBe("claw/issue-99-issue");
  });
});

describe("slugify", () => {
  it("lowercases and collapses runs of non-alphanumeric chars to single hyphens", () => {
    expect(slugify("Implementation Agent — fix cycles")).toBe(
      "implementation-agent-fix-cycles",
    );
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("-- foo --")).toBe("foo");
  });

  it("truncates to the max length", () => {
    const input = "a".repeat(BRANCH_SLUG_MAX_LENGTH + 10);
    expect(slugify(input)).toBe("a".repeat(BRANCH_SLUG_MAX_LENGTH));
  });

  it("strips a trailing hyphen after truncation", () => {
    // 41 characters where a hyphen lands in position 40 after truncation.
    const base = `${"a".repeat(BRANCH_SLUG_MAX_LENGTH)}-extra`;
    const result = slugify(base);
    expect(result.endsWith("-")).toBe(false);
    expect(result.length).toBeLessThanOrEqual(BRANCH_SLUG_MAX_LENGTH);
  });

  it("returns `issue` for empty-or-only-punctuation input", () => {
    expect(slugify("")).toBe("issue");
    expect(slugify("---")).toBe("issue");
  });

  it("preserves digits and embedded numbers", () => {
    expect(slugify("v0.1 — The Loop")).toBe("v0-1-the-loop");
  });
});
