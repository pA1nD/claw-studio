import { detectRepo } from "../../core/github/repo-detect.js";
import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/** Options accepted by the `claw start` command. */
export interface StartOptions {
  repo?: string;
  autoContinue?: boolean;
  dryRun?: boolean;
}

/**
 * `claw start` — stub.
 *
 * Resolves the target repo via the standard detection chain, then prints a
 * placeholder confirmation. Real loop logic lands in v0.1.
 */
export async function startCommand(options: StartOptions): Promise<void> {
  const ref = await detectRepo({ explicit: options.repo });
  const flags: string[] = [];
  if (options.autoContinue) flags.push("--auto-continue");
  if (options.dryRun) flags.push("--dry-run");
  const detail = flags.length > 0 ? `flags: ${flags.join(" ")}` : "flags: (none)";
  await renderOnce(<Success message={`start — ${ref.owner}/${ref.repo}`} detail={detail} />);
}
