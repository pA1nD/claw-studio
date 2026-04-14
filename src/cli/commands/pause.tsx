import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/**
 * `claw pause` — stub.
 *
 * Pauses the loop after the current action completes. Real pause
 * semantics are implemented alongside the loop orchestrator in v0.1.
 */
export async function pauseCommand(): Promise<void> {
  await renderOnce(
    <Success
      message="pause"
      detail="stub — the loop orchestrator is implemented in v0.1"
    />,
  );
}
