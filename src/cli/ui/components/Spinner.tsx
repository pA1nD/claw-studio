import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_INTERVAL_MS = 80;

/** Props for {@link Spinner}. */
export interface SpinnerProps {
  /** Message shown next to the spinner. */
  message: string;
}

/**
 * Lightweight loading spinner with a message.
 *
 * Intentionally dependency-free so the CLI does not pull in a heavier
 * spinner library for a single glyph animation.
 */
export function Spinner({ message }: SpinnerProps): JSX.Element {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const glyph = FRAMES[frame] ?? FRAMES[0];

  return (
    <Box paddingX={2} paddingY={1}>
      <Text>
        <Text color={theme.brand}>{glyph} </Text>
        <Text color={theme.text}>{message}</Text>
      </Text>
    </Box>
  );
}
