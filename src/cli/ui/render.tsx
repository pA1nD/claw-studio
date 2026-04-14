import type { ReactElement } from "react";
import { render } from "ink";
import { ErrorView } from "./components/Error.js";
import { ClawError, isClawError } from "../../core/types/errors.js";

/**
 * Render an Ink element once, flush it to the terminal, and resolve.
 *
 * Used for one-shot CLI output (command stubs, error screens, success
 * confirmations). Does not keep the process alive after the frame is drawn.
 *
 * Note — animation constraint:
 * `unmount()` is called immediately, which fires every `useEffect` cleanup
 * before the first interval tick. Components that depend on continuous
 * updates (e.g. {@link Spinner}) will only render their initial frame.
 * Long-running UI must use a different rendering strategy that keeps the
 * Ink instance alive for the duration of the work.
 */
export async function renderOnce(element: ReactElement): Promise<void> {
  const instance = render(element);
  instance.unmount();
  await instance.waitUntilExit();
}

/**
 * Render a ClawError using the standard error view.
 * Unknown throwables are wrapped so the output is always consistent.
 */
export async function renderError(err: unknown): Promise<void> {
  const clawError: ClawError = isClawError(err)
    ? err
    : new ClawError(
        err instanceof Error && err.message ? err.message : "unexpected error.",
      );
  await renderOnce(<ErrorView message={clawError.message} hint={clawError.hint} />);
}
