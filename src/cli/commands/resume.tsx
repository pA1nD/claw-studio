import { Success } from "../ui/components/Success.js";
import { renderOnce } from "../ui/render.js";

/**
 * `claw resume` — stub.
 *
 * Resumes a paused loop. Real resume semantics are implemented alongside
 * the loop orchestrator in v0.1.
 */
export async function resumeCommand(): Promise<void> {
  await renderOnce(
    <Success
      message="resume"
      detail="stub — the loop orchestrator is implemented in v0.1"
    />,
  );
}
