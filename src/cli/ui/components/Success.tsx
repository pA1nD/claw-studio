import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

/** Props for {@link Success}. */
export interface SuccessProps {
  /** Main success message. */
  message: string;
  /** Optional secondary detail line. */
  detail?: string;
}

/**
 * Success / confirmation display component.
 * Used when a command completes cleanly.
 */
export function Success({ message, detail }: SuccessProps): ReactElement {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text>
        <Text color={theme.success}>✓ </Text>
        <Text color={theme.text}>{message}</Text>
      </Text>
      {detail ? <Text color={theme.muted}>{detail}</Text> : null}
    </Box>
  );
}
