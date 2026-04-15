import { describe, it, expect } from "vitest";
import {
  REVIEW_AGENTS,
  extractIssueNumberFromBranch,
  extractLinkedIssue,
} from "../../../src/core/checks/pr.js";

describe("REVIEW_AGENTS", () => {
  it("lists the five review agents the pipeline expects", () => {
    expect(REVIEW_AGENTS).toEqual(["Arch", "DX", "Security", "Perf", "Test"]);
  });
});

describe("extractLinkedIssue", () => {
  it("returns null when the body is empty", () => {
    expect(extractLinkedIssue("")).toBeNull();
    expect(extractLinkedIssue(null)).toBeNull();
    expect(extractLinkedIssue(undefined)).toBeNull();
  });

  it("extracts a simple `Closes #N` marker", () => {
    expect(extractLinkedIssue("Closes #7")).toBe(7);
  });

  it("accepts every variant GitHub recognises", () => {
    expect(extractLinkedIssue("close #1")).toBe(1);
    expect(extractLinkedIssue("closes #2")).toBe(2);
    expect(extractLinkedIssue("closed #3")).toBe(3);
    expect(extractLinkedIssue("fix #4")).toBe(4);
    expect(extractLinkedIssue("fixes #5")).toBe(5);
    expect(extractLinkedIssue("fixed #6")).toBe(6);
    expect(extractLinkedIssue("resolve #7")).toBe(7);
    expect(extractLinkedIssue("resolves #8")).toBe(8);
    expect(extractLinkedIssue("resolved #9")).toBe(9);
  });

  it("is case-insensitive on the keyword", () => {
    expect(extractLinkedIssue("CLOSES #42")).toBe(42);
    expect(extractLinkedIssue("Fixes #42")).toBe(42);
  });

  it("returns the first marker when multiple are present", () => {
    expect(extractLinkedIssue("Closes #1 and closes #2")).toBe(1);
  });

  it("returns null when no keyword precedes the issue reference", () => {
    expect(extractLinkedIssue("See #42 for context.")).toBeNull();
  });

  it("requires a `#` prefix", () => {
    expect(extractLinkedIssue("closes 42")).toBeNull();
  });
});

describe("extractIssueNumberFromBranch", () => {
  it("extracts the issue number from a canonical claw branch", () => {
    expect(extractIssueNumberFromBranch("claw/issue-7-roadmap-parser")).toBe(7);
  });

  it("extracts the issue number when there is no slug", () => {
    expect(extractIssueNumberFromBranch("claw/issue-7")).toBe(7);
  });

  it("returns null for branches without the claw/ prefix", () => {
    expect(extractIssueNumberFromBranch("feature/issue-7-foo")).toBeNull();
  });

  it("returns null for branches that are not issue-numbered", () => {
    expect(extractIssueNumberFromBranch("claw/main")).toBeNull();
  });
});
