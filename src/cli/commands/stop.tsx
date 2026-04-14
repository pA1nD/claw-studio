import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/**
 * `claw stop` — stub.
 *
 * Stops the loop cleanly. Real stop semantics are implemented alongside
 * the loop orchestrator in v0.1.
 */
export async function stopCommand(): Promise<void> {
  await renderOnce(
    <Success
      message="stop"
      detail="stub — the loop orchestrator is implemented in v0.1"
    />,
  );
}
