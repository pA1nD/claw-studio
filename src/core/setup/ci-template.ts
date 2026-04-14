import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClawError } from "../types/errors.js";

/** Options for {@link loadCiTemplate}. */
export interface LoadCiTemplateOptions {
  /** Injected dependencies for testing. */
  deps?: LoadCiTemplateDeps;
}

/** Injectable dependencies so template loading can be unit-tested without hitting disk. */
export interface LoadCiTemplateDeps {
  /** Reads the template file as UTF-8. Defaults to `fs.readFile(path, "utf8")`. */
  readFile?: (path: string) => Promise<string>;
  /** Returns the absolute path of the canonical template. Defaults to the bundled file. */
  resolveTemplatePath?: () => string;
}

/**
 * Load the canonical `.github/workflows/ci.yml` template that ships with
 * Claw Studio.
 *
 * Per issue #18, the template is the "full Claw Studio pipeline" — lint,
 * typecheck, tests, and the 5 review agents. It is copied verbatim today;
 * v0.5 introduces per-project review-agent prompt tailoring, which this
 * loader will gain as a transform step.
 *
 * @param options optional injected deps for testing
 * @returns the raw YAML contents to write to `.github/workflows/ci.yml`
 * @throws {ClawError} when the template file cannot be read
 */
export async function loadCiTemplate(
  options: LoadCiTemplateOptions = {},
): Promise<string> {
  const read = options.deps?.readFile ?? defaultReadFile;
  const resolveTemplatePath =
    options.deps?.resolveTemplatePath ?? defaultResolveTemplatePath;
  const path = resolveTemplatePath();
  try {
    return await read(path);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      "could not read the bundled ci.yml template.",
      `Expected it at ${path}. Reinstall Claw Studio if the file is missing. (${detail})`,
    );
  }
}

/** Default template path — resolved relative to this source file. */
export function defaultResolveTemplatePath(): string {
  // `import.meta.url` points at src/core/setup/ci-template.ts at build time,
  // so the template sits one directory up in `core/templates/ci.yml`.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "templates", "ci.yml");
}

/** Default implementation: read the file as UTF-8. */
function defaultReadFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
