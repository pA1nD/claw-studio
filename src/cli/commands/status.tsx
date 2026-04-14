import { detectRepo } from "../../core/github/repo-detect.js";
import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/** Options accepted by the `claw status` command. */
export interface StatusOptions {
  repo?: string;
}

/**
 * `claw status` — stub.
 *
 * Resolves the target repo via the standard detection chain, then prints a
 * placeholder confirmation. Real state inspection lands in v0.1.
 */
export async function statusCommand(options: StatusOptions): Promise<void> {
  const ref = await detectRepo({ explicit: options.repo });
  await renderOnce(
    <Success
      message={`status — ${ref.owner}/${ref.repo}`}
      detail="stub — repo state checks will be implemented in v0.1"
    />,
  );
}
