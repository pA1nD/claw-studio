import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  defaultResolveTemplatePath,
  loadCiTemplate,
} from "../../../src/core/setup/ci-template.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("loadCiTemplate", () => {
  it("returns the canonical template contents via injected deps", async () => {
    const contents = await loadCiTemplate({
      deps: {
        resolveTemplatePath: () => "/fake/ci.yml",
        readFile: async (path: string) => {
          expect(path).toBe("/fake/ci.yml");
          return "name: CI\n";
        },
      },
    });
    expect(contents).toBe("name: CI\n");
  });

  it("throws ClawError when the template cannot be read", async () => {
    const error = await loadCiTemplate({
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

  it("ships the canonical template with Claw Studio — 5 review agents + merge gate", async () => {
    // Read the real bundled template (resolved relative to this source file)
    // to catch regressions where the file is accidentally deleted or
    // restructured away from the canonical pipeline.
    const contents = await readFile(
      resolve(process.cwd(), "src", "core", "templates", "ci.yml"),
      "utf8",
    );
    expect(contents).toContain("name: CI");
    // All 5 review agent jobs exist in the pipeline (YAML top-level keys
    // are indented at column 2 inside `jobs:`).
    expect(contents).toContain("\n  arch:");
    expect(contents).toContain("\n  dx:");
    expect(contents).toContain("\n  security:");
    expect(contents).toContain("\n  perf:");
    expect(contents).toContain("\n  test-review:");
    // And the merge-gate summary job.
    expect(contents).toContain("\n  summary:");
    expect(contents).toContain("Review Summary");
  });

  it("defaultResolveTemplatePath returns a path inside src/core/templates", () => {
    const path = defaultResolveTemplatePath();
    expect(path).toMatch(/[\\/]core[\\/]templates[\\/]ci\.yml$/);
  });
});
