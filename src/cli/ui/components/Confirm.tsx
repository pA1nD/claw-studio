import { useState, type ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

/** Props for {@link Confirm}. */
export interface ConfirmProps {
  /** Heading line shown above the body. */
  title: string;
  /** Details the human should read before answering. */
  lines: readonly string[];
  /** `(Y/n)` — `Y` defaults to true; `(y/N)` defaults to false. */
  defaultYes?: boolean;
  /** Called once with the user's choice. Must be idempotent. */
  onAnswer: (accepted: boolean) => void;
}

/**
 * Interactive yes/no prompt.
 *
 * Single keystroke accepted:
 *   - `y` → accepted
 *   - `n` → declined
 *   - `return` → accepts the default
 *   - `escape` → declined (always safe)
 */
export function Confirm({
  title,
  lines,
  defaultYes = true,
  onAnswer,
}: ConfirmProps): ReactElement {
  const [answered, setAnswered] = useState(false);

  useInput((input, key) => {
    if (answered) return;
    const lower = input.toLowerCase();
    if (lower === "y") {
      setAnswered(true);
      onAnswer(true);
      return;
    }
    if (lower === "n" || key.escape) {
      setAnswered(true);
      onAnswer(false);
      return;
    }
    if (key.return) {
      setAnswered(true);
      onAnswer(defaultYes);
    }
  });

  const prompt = defaultYes ? "Proceed? (Y/n)" : "Proceed? (y/N)";

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.brand}>{title}</Text>
      <Box marginTop={1} flexDirection="column">
        {lines.map((line) => (
          <Text key={line} color={theme.text}>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>{prompt}</Text>
      </Box>
    </Box>
  );
}
