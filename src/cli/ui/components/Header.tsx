import { Box, Text } from "ink";
import { theme } from "../theme.js";

/**
 * Header component shown when `claw` runs with no arguments.
 * Renders the Claw Studio banner and the top-level commands.
 */
export function Header(): JSX.Element {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.brand}>╔═══════════════════════════╗</Text>
      <Text color={theme.brand}>║  Claw Studio              ║</Text>
      <Text color={theme.brand}>║  Claw your way.           ║</Text>
      <Text color={theme.brand}>╚═══════════════════════════╝</Text>
      <Box marginTop={1} flexDirection="column">
        <CommandLine name="claw setup " description="set up a repo for Claw Studio" />
        <CommandLine name="claw start " description="start the loop" />
        <CommandLine name="claw status" description="show current state" />
        <CommandLine name="claw help  " description="show all commands" />
      </Box>
    </Box>
  );
}

/** One line in the header's command summary. */
function CommandLine({ name, description }: { name: string; description: string }): JSX.Element {
  return (
    <Text>
      <Text color={theme.brand}>{name}</Text>
      <Text color={theme.muted}>    {description}</Text>
    </Text>
  );
}
