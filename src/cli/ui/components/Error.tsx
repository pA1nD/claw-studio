import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

/** Props for {@link ErrorView}. */
export interface ErrorViewProps {
  /** Short description of what is wrong. Rendered after `[CLAW] Stopped —`. */
  message: string;
  /** Optional single-line instruction for the human. */
  hint?: string;
}

/**
 * Error display component.
 *
 * Renders the standard Claw Studio error format:
 *
 *     [CLAW] Stopped — {what is wrong}
 *     {what to look at or do}
 *     Run `claw status` to re-check once resolved.
 */
export function ErrorView({ message, hint }: ErrorViewProps): ReactElement {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.error}>[CLAW] Stopped — {message}</Text>
      {hint ? <Text color={theme.text}>{hint}</Text> : null}
      <Text color={theme.muted}>Run `claw status` to re-check once resolved.</Text>
    </Box>
  );
}
