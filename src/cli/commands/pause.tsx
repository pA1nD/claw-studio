import { setPauseFlag } from "../../core/loop/control.js";
import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/**
 * `claw pause` — set the pause flag.
 *
 * The running loop polls the flag between cycles, so a pause is non-
 * destructive: any in-flight implementation agent or fix run completes before
 * the loop honours the signal.
 */
export async function pauseCommand(): Promise<void> {
  await setPauseFlag(process.cwd());
  await renderOnce(
    <Success
      message="pause requested"
      detail="the loop will pause after the current action — run `claw resume` to continue."
    />,
  );
}
