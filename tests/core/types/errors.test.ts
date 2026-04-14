import { describe, it, expect } from "vitest";
import { ClawError, isClawError } from "../../../src/core/types/errors.js";

describe("ClawError", () => {
  it("has name 'ClawError' so it is distinguishable in catch blocks", () => {
    const err = new ClawError("something went wrong");
    expect(err.name).toBe("ClawError");
  });

  it("preserves the message on the Error base", () => {
    const err = new ClawError("something went wrong");
    expect(err.message).toBe("something went wrong");
  });

  it("stores the optional hint when provided", () => {
    const err = new ClawError("broken", "fix it");
    expect(err.hint).toBe("fix it");
  });

  it("leaves hint undefined when omitted", () => {
    const err = new ClawError("broken");
    expect(err.hint).toBeUndefined();
  });

  it("is an instanceof Error — prototype chain is intact", () => {
    const err = new ClawError("broken");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ClawError);
  });
});

describe("isClawError", () => {
  it("returns true for a ClawError instance", () => {
    expect(isClawError(new ClawError("x"))).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isClawError(new Error("x"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isClawError(null)).toBe(false);
    expect(isClawError(undefined)).toBe(false);
    expect(isClawError("string")).toBe(false);
    expect(isClawError(42)).toBe(false);
    expect(isClawError({ message: "fake" })).toBe(false);
  });
});
