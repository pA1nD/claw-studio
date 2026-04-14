import { detectRepo } from "../../core/github/repo-detect.js";
import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/** Options accepted by the `claw setup` command. */
export interface SetupOptions {
  repo?: string;
  overwrite?: boolean;
}

/**
 * `claw setup` — stub.
 *
 * Resolves the target repo via the standard detection chain, then prints a
 * placeholder confirmation. Real setup logic lands in issue #18.
 */
export async function setupCommand(options: SetupOptions): Promise<void> {
  const ref = await detectRepo({ explicit: options.repo });
  const detail = options.overwrite
    ? "mode: overwrite — existing Claw Studio files will be replaced"
    : "mode: fresh — refuses to run if Claw Studio files already exist";
  await renderOnce(<Success message={`setup — ${ref.owner}/${ref.repo}`} detail={detail} />);
}
