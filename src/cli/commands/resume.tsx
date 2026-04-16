import { clearPauseFlag } from "../../core/loop/control.js";
import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/**
 * `claw resume` — clear the pause flag.
 *
 * The running loop picks up the cleared flag at its next poll. If no loop is
 * running, this command is a no-op cleanup — the next `claw start` will start
 * unpaused.
 */
export async function resumeCommand(): Promise<void> {
  await clearPauseFlag(process.cwd());
  await renderOnce(
    <Success
      message="pause cleared"
      detail="if a loop is running it will resume on its next poll — otherwise run `claw start`."
    />,
  );
}
