import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { readLastEntries } from "../../core/loop/log.js";
import { theme } from "../ui/theme.js";
import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/** Options accepted by the `claw logs` command. */
export interface LogsOptions {
  tail?: boolean;
  n?: number;
}

/** Default number of log entries shown when `--n` is not provided. */
const DEFAULT_LOG_COUNT = 20;

/**
 * `claw logs` — print the trailing entries of `.claw/loop.log`.
 *
 * Each line of the log carries an ISO timestamp followed by the cycle outcome
 * (`ACTION`, `WAIT`, `HALT`, `MILESTONE_COMPLETE`, `PAUSED`, or a `WARNING`
 * surfaced by the idle detector). The `--tail` flag is reserved for follow
 * mode (post-v0.1).
 *
 * @param options CLI options (`--tail`, `--n <count>`)
 */
export async function logsCommand(options: LogsOptions): Promise<void> {
  const count =
    typeof options.n === "number" && options.n > 0 ? options.n : DEFAULT_LOG_COUNT;
  const entries = await readLastEntries(process.cwd(), count);

  if (entries.length === 0) {
    await renderOnce(
      <Success
        message="no log entries yet"
        detail="run `claw start` to begin — every cycle appends to .claw/loop.log."
      />,
    );
    return;
  }

  await renderOnce(<LogList entries={entries} tail={options.tail === true} />);
}

/** Render a list of trailing log entries. */
function LogList({
  entries,
  tail,
}: {
  entries: readonly string[];
  tail: boolean;
}): ReactElement {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {entries.map((line, idx) => (
        <Text key={`log-${idx}`} color={theme.text}>
          {line}
        </Text>
      ))}
      {tail ? (
        <Text color={theme.muted}>
          (tail mode is reserved for v0.2 — re-run `claw logs` to refresh)
        </Text>
      ) : null}
    </Box>
  );
}
