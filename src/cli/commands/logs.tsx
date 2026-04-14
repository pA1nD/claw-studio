import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/** Options accepted by the `claw logs` command. */
export interface LogsOptions {
  tail?: boolean;
  n?: number;
}

/**
 * `claw logs` — stub.
 *
 * Shows recent loop activity. Real log output is implemented alongside
 * the loop orchestrator in v0.1.
 */
export async function logsCommand(options: LogsOptions): Promise<void> {
  const flags: string[] = [];
  if (options.tail) flags.push("--tail");
  if (typeof options.n === "number") flags.push(`--n ${options.n}`);
  const detail = flags.length > 0 ? `flags: ${flags.join(" ")}` : "flags: (none)";
  await renderOnce(<Success message="logs" detail={detail} />);
}
