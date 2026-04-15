import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClawError } from "../types/errors.js";

/** Options for {@link loadCiTemplate}. */
export interface LoadCiTemplateOptions {
  /**
   * The target repository in `owner/repo` format.
   * Substituted into the `{{REPO}}` placeholder in every review agent prompt
   * so agents identify themselves against the right project.
   */
  repo: string;
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
 * Claw Studio, with all `{{REPO}}` placeholders substituted for the target repo.
 *
 * The template uses `{{REPO}}` in every review agent prompt so agents identify
 * themselves against the right project rather than "Claw Studio". For example:
 *   "You are Arch, a code architecture reviewer for owner/repo."
 *
 * Per issue #18, the template is otherwise copied verbatim today.
 * v0.5 introduces full per-project review-agent prompt tailoring (generated
 * from README + ROADMAP), which this loader will gain as an additional
 * transform step at that milestone.
 *
 * @param options repo + optional injected deps for testing
 * @returns the YAML contents ready to write to `.github/workflows/ci.yml`
 * @throws {ClawError} when the template file cannot be read
 */
export async function loadCiTemplate(
  options: LoadCiTemplateOptions,
): Promise<string> {
  const read = options.deps?.readFile ?? defaultReadFile;
  const resolveTemplatePath =
    options.deps?.resolveTemplatePath ?? defaultResolveTemplatePath;
  const path = resolveTemplatePath();
  let template: string;
  try {
    template = await read(path);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      "could not read the bundled ci.yml template.",
      `Expected it at ${path}. Reinstall Claw Studio if the file is missing. (${detail})`,
    );
  }
  return template.replaceAll("{{REPO}}", options.repo);
}

/** Default template path — resolved relative to this source file. */
export function defaultResolveTemplatePath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, "../templates/ci.yml");
}

async function defaultReadFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
