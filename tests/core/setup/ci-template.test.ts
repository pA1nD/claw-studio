import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  defaultResolveTemplatePath,
  loadCiTemplate,
} from "../../../src/core/setup/ci-template.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("loadCiTemplate", () => {
  it("returns the template with {{REPO}} substituted", async () => {
    const contents = await loadCiTemplate({
      repo: "owner/my-project",
      deps: {
        resolveTemplatePath: () => "/fake/ci.yml",
        readFile: async (path: string) => {
          expect(path).toBe("/fake/ci.yml");
          return "You are Arch, a reviewer for {{REPO}}.\n";
        },
      },
    });
    expect(contents).toBe("You are Arch, a reviewer for owner/my-project.\n");
    expect(contents).not.toContain("{{REPO}}");
  });

  it("substitutes all occurrences of {{REPO}}", async () => {
    const contents = await loadCiTemplate({
      repo: "pA1nD/sheetsdb",
      deps: {
        resolveTemplatePath: () => "/fake/ci.yml",
        readFile: async () =>
          "{{REPO}} reviewed by {{REPO}} for {{REPO}}.",
      },
    });
    expect(contents).toBe(
      "pA1nD/sheetsdb reviewed by pA1nD/sheetsdb for pA1nD/sheetsdb.",
    );
  });

  it("throws ClawError when the template cannot be read", async () => {
    const error = await loadCiTemplate({
      repo: "owner/repo",
      deps: {
        resolveTemplatePath: () => "/missing.yml",
        readFile: async () => {
          throw new Error("ENOENT");
        },
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("ci.yml template");
  });

  it("ships the canonical template with 5 review agents + merge gate", async () => {
    const contents = await readFile(
      resolve(process.cwd(), "src", "core", "templates", "ci.yml"),
      "utf8",
    );
    expect(contents).toContain("name: CI");
    // All 5 review agent jobs exist
    expect(contents).toContain("\n  arch:");
    expect(contents).toContain("\n  dx:");
    expect(contents).toContain("\n  security:");
    expect(contents).toContain("\n  perf:");
    expect(contents).toContain("\n  test-review:");
    // Merge-gate summary job
    expect(contents).toContain("\n  summary:");
    expect(contents).toContain("Review Summary");
    // Generic {{REPO}} placeholder — not project-specific
    expect(contents).toContain("{{REPO}}");
    expect(contents).not.toContain("Claw Studio");
  });

  it("defaultResolveTemplatePath returns a path inside src/core/templates", () => {
    const path = defaultResolveTemplatePath();
    expect(path).toMatch(/[\\/]core[\\/]templates[\\/]ci\.yml$/);
  });
});
