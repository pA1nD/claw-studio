import { useState, type ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

/** Props for {@link HumanStep}. */
export interface HumanStepProps {
  /** Step title (e.g. "Runners" or "Claude token"). */
  title: string;
  /** One-line description of why this step is needed. */
  reason: string;
  /** The GitHub settings URL the human should open. */
  url: string;
  /** Extra instructions shown after the URL. */
  details: readonly string[];
  /**
   * Optional verifier. When present, pressing the primary key calls it.
   * The component only resolves once the verifier returns `true`. Return
   * `false` to re-prompt with a "not yet" hint.
   */
  verify?: () => Promise<boolean>;
  /** Called once the human has completed the step (and verification passes). */
  onDone: () => void;
}

type Status = "idle" | "checking" | "not-yet" | "error";

/**
 * Interactive wizard card for a single human step.
 *
 * Keystrokes:
 *   - `return` → run verifier (if set) or mark the step done
 *   - `s` → skip verification (token step, where verification is impossible)
 *
 * Kept deliberately small — the wizard is a recurring shape in v0.5 when the
 * dashboard grows its own in-UI step panel. This is the terminal-first
 * version of exactly that panel.
 */
export function HumanStep({
  title,
  reason,
  url,
  details,
  verify,
  onDone,
}: HumanStepProps): ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useInput((input, key) => {
    if (status === "checking") return;
    const lower = input.toLowerCase();

    if (key.return) {
      if (!verify) {
        onDone();
        return;
      }
      setStatus("checking");
      setMessage("Checking…");
      verify().then(
        (passed) => {
          if (passed) {
            onDone();
          } else {
            setStatus("not-yet");
            setMessage("Not detected yet — try again once the step is complete.");
          }
        },
        (err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          setStatus("error");
          setMessage(`Check failed: ${detail}`);
        },
      );
      return;
    }

    if (lower === "s" && !verify) {
      // Only no-verify steps accept skip. Verify-enabled steps must succeed.
      onDone();
    }
  });

  const hint = verify
    ? "Press <enter> once complete — I'll verify."
    : "Press <enter> when complete. Press `s` to skip verification.";

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.brand}>{title}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text}>{reason}</Text>
        <Text color={theme.muted}>Open: {url}</Text>
        {details.map((line) => (
          <Text key={line} color={theme.text}>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>{hint}</Text>
        {message ? (
          <Text color={status === "error" ? theme.error : theme.muted}>
            {message}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
