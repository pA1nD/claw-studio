#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { Header } from "./ui/components/Header.js";
import { renderOnce, renderError } from "./ui/render.js";
import { setupCommand } from "./commands/setup.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { pauseCommand } from "./commands/pause.js";
import { resumeCommand } from "./commands/resume.js";
import { stopCommand } from "./commands/stop.js";
import { logsCommand } from "./commands/logs.js";
import { ClawError } from "../core/types/errors.js";
import { loadDotenvIntoProcessEnv } from "../core/setup/dotenv-loader.js";

const VERSION = "0.0.1";

/**
 * Build the commander program with every `claw` sub-command registered.
 * Exposed as a function so tests can build a fresh program and inspect it.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("claw")
    .description("Claw your way. — Autonomous software factory.")
    .version(VERSION, "-v, --version", "show the Claw Studio version")
    .helpOption("-h, --help", "show help for a command");

  // When `claw` is invoked with no sub-command, show the branded header.
  program.action(async () => {
    await renderOnce(<Header />);
  });

  program
    .command("setup")
    .description("set up a repo for Claw Studio")
    .option("--repo <owner/repo>", "target GitHub repository")
    .option("--overwrite", "replace existing Claw Studio files", false)
    .option("-y, --yes", "skip the confirmation prompt", false)
    .option("--skip-runners", "do not provision Docker-backed self-hosted runners", false)
    .option(
      "--runner-count <n>",
      "number of self-hosted runners to provision (default: 6)",
      parseRunnerCount,
    )
    .option("--github-pat <token>", "override GITHUB_PAT for this invocation")
    .option("--claude-token <token>", "override CLAUDE_CODE_OAUTH_TOKEN for this invocation")
    .action(
      async (options: {
        repo?: string;
        overwrite?: boolean;
        yes?: boolean;
        skipRunners?: boolean;
        runnerCount?: number;
        githubPat?: string;
        claudeToken?: string;
      }) => {
        await setupCommand(options);
      },
    );

  program
    .command("start")
    .description("start the loop")
    .option("--repo <owner/repo>", "target GitHub repository")
    .option("--auto-continue", "roll into the next milestone without prompting", false)
    .option("--dry-run", "report what would happen without taking actions", false)
    .action(
      async (options: { repo?: string; autoContinue?: boolean; dryRun?: boolean }) => {
        await startCommand(options);
      },
    );

  program
    .command("status")
    .description("show current state")
    .option("--repo <owner/repo>", "target GitHub repository")
    .action(async (options: { repo?: string }) => {
      await statusCommand(options);
    });

  program
    .command("pause")
    .description("pause after the current action")
    .action(async () => {
      await pauseCommand();
    });

  program
    .command("resume")
    .description("resume from paused")
    .action(async () => {
      await resumeCommand();
    });

  program
    .command("stop")
    .description("stop the loop cleanly")
    .action(async () => {
      await stopCommand();
    });

  program
    .command("logs")
    .description("show loop history")
    .option("--tail", "follow the log stream", false)
    .option("--n <count>", "number of log entries to show", parseLogEntryCount)
    .action(async (options: { tail?: boolean; n?: number }) => {
      await logsCommand(options);
    });

  // Commander provides `help [command]` automatically via addHelpCommand.
  // Customise the description so the built-in command matches the roadmap.
  program.addHelpCommand("help [command]", "show help for a command");

  return program;
}

/**
 * Commander option coercion for `logs --n <count>`.
 *
 * Parses the raw string into a non-negative integer. Throws a `ClawError`
 * on any other input so the standard error view is rendered.
 *
 * Exported so the validator can be unit-tested without going through
 * Commander's parse lifecycle.
 *
 * @param value raw option value captured by Commander
 * @returns the parsed non-negative integer
 * @throws {ClawError} when the value is not a non-negative integer
 */
export function parseLogEntryCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new ClawError(
      "invalid value for --n.",
      "Pass a non-negative integer (e.g. --n 20).",
    );
  }
  return parsed;
}

/**
 * Commander option coercion for `setup --runner-count <n>`.
 *
 * Parses the raw string into a positive integer. Throws a `ClawError` on any
 * other input so the standard error view is rendered.
 *
 * @param value raw option value captured by Commander
 * @returns the parsed positive integer
 * @throws {ClawError} when the value is not a positive integer
 */
export function parseRunnerCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ClawError(
      "invalid value for --runner-count.",
      "Pass a positive integer (e.g. --runner-count 6).",
    );
  }
  return parsed;
}

/**
 * Run the `claw` CLI.
 * Any uncaught error is converted to a ClawError and rendered via the
 * standard error view. Exit code is set to 1 on failure; the process is
 * never terminated with `process.exit` — the typed error system owns lifetime.
 */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  // Load .claw/.env so every command — `claw start`, `claw status`, the loop —
  // picks up persisted GITHUB_PAT and CLAUDE_CODE_OAUTH_TOKEN automatically.
  // Explicit env vars on this invocation still win: loadDotenvIntoProcessEnv
  // only sets keys that are not already present in process.env.
  try {
    await loadDotenvIntoProcessEnv(process.cwd());
  } catch (err) {
    // A malformed .claw/.env is worth surfacing early — surface the error and
    // exit, rather than letting every command fail with a downstream token-
    // resolution error that points at a different symptom.
    await renderError(err);
    process.exitCode = 1;
    return;
  }

  const program = buildProgram();
  try {
    await program.parseAsync(argv as string[]);
  } catch (err) {
    await renderError(err);
    process.exitCode = 1;
  }
}

// Run immediately when invoked as a binary. The guard keeps the module
// importable from tests without side effects. `realpathSync` resolves
// the symlink that `npm install -g` creates (e.g. /usr/local/bin/claw →
// dist/cli/index.js) so the check works whether invoked via the symlink
// or directly.
import { realpathSync } from "node:fs";
const entryPath = process.argv[1];
const invokedDirectly = (() => {
  if (typeof entryPath !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return import.meta.url === pathToFileURL(entryPath).href;
  }
})();
if (invokedDirectly) {
  void main();
}
