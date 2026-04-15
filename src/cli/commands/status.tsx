import { createClient } from "../../core/github/client.js";
import { detectRepo } from "../../core/github/repo-detect.js";
import { inspectRepo } from "../../core/checks/inspector.js";
import { ErrorView } from "../ui/components/Error.js";
import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/** Options accepted by the `claw status` command. */
export interface StatusOptions {
  repo?: string;
}

/**
 * `claw status` — run the 13 ordered repo state checks and report the result.
 *
 * Three outcomes:
 *   - All checks pass → print a green confirmation.
 *   - A check fails → render the standard `[CLAW] Stopped — …` error view.
 *   - The milestone is complete (CHECK 4) → render the same error view, but
 *     the human reads it as "we're done here, point me at the next one"
 *     rather than as a failure.
 *
 * The command is read-only: it never starts the loop or takes action.
 *
 * @param options CLI options (`--repo`)
 */
export async function statusCommand(options: StatusOptions): Promise<void> {
  const ref = await detectRepo({ explicit: options.repo });
  const client = createClient();

  const result = await inspectRepo(client, `${ref.owner}/${ref.repo}`);

  if (result.passed) {
    await renderOnce(
      <Success
        message={`status — ${ref.owner}/${ref.repo}`}
        detail="all checks passing — ready to start the loop with `claw start`."
      />,
    );
    return;
  }

  // CHECK 4 (milestone complete) is a "happy" failure — same `[CLAW] Stopped`
  // view shape, but exit cleanly so callers don't treat a finished milestone
  // as an error.
  await renderOnce(
    <ErrorView message={result.error.message} hint={result.error.hint} />,
  );
  if (!result.terminal) {
    process.exitCode = 1;
  }
}
