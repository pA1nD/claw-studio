import { describe, expect, it } from "vitest";
import type { Octokit } from "@octokit/rest";
import { check01Roadmap } from "../../../src/core/checks/check-01-roadmap.js";
import { ClawError } from "../../../src/core/types/errors.js";

const stubClient = {} as Octokit;
const ref = { owner: "pA1nD", repo: "claw-studio" };

describe("check01Roadmap", () => {
  it("passes and returns the file contents when ROADMAP.md exists", async () => {
    const result = await check01Roadmap(stubClient, ref, {
      readRoadmap: async () => "## Current milestone: v0.1",
    });
    expect(result.passed).toBe(true);
    expect(result.content).toBe("## Current milestone: v0.1");
    expect(result.error).toBeUndefined();
  });

  it("fails with a ClawError when ROADMAP.md is missing", async () => {
    const result = await check01Roadmap(stubClient, ref, {
      readRoadmap: async () => null,
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain(
      `no ROADMAP.md found in ${ref.owner}/${ref.repo}`,
    );
    expect(result.error?.hint).toContain("Add a ROADMAP.md");
  });

  it("re-throws errors from readRoadmap other than not-found", async () => {
    const error = await check01Roadmap(stubClient, ref, {
      readRoadmap: async () => {
        throw new Error("rate limit exceeded");
      },
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("rate limit exceeded");
  });

  it("passes the correct ref to the readRoadmap dep", async () => {
    let seen: { owner: string; repo: string } | null = null;
    await check01Roadmap(stubClient, ref, {
      readRoadmap: async (r) => {
        seen = { owner: r.owner, repo: r.repo };
        return "ok";
      },
    });
    expect(seen).toEqual(ref);
  });
});
