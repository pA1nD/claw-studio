import { setStopFlag } from "../../core/loop/control.js";
import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/**
 * `claw stop` — set the stop flag.
 *
 * The running loop checks the flag at the top of each iteration, so a stop is
 * non-destructive: any in-flight implementation agent or fix run completes
 * before the loop exits cleanly.
 */
export async function stopCommand(): Promise<void> {
  await setStopFlag(process.cwd());
  await renderOnce(
    <Success
      message="stop requested"
      detail="the loop will exit after the current action — run `claw start` to launch a fresh loop."
    />,
  );
}
