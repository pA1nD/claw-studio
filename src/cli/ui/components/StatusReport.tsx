import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

/** Props for {@link StatusReport}. */
export interface StatusReportProps {
  /** `owner/repo` slug the inspector just ran against. */
  repo: string;
  /** Current milestone name (e.g. `"v0.1"`). */
  milestone: string;
  /** How many issues carry the milestone label. */
  totalIssues: number;
  /** How many of those issues are still open. */
  openIssues: number;
  /** How many open `claw/` PRs the inspector found. */
  openPullRequests: number;
}

/**
 * Success view for `claw status` — shown after every check passes.
 *
 * Mirrors the tone of {@link Success}: a single ✓ line, plus a small
 * summary so the human has something useful to read beyond "OK".
 */
export function StatusReport(props: StatusReportProps): ReactElement {
  const { repo, milestone, totalIssues, openIssues, openPullRequests } = props;
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text>
        <Text color={theme.success}>✓ </Text>
        <Text color={theme.text}>all checks passing — {repo}</Text>
      </Text>
      <Text color={theme.muted}>
        milestone {milestone} · {openIssues}/{totalIssues} open · {openPullRequests} open PR
        {openPullRequests === 1 ? "" : "s"}
      </Text>
    </Box>
  );
}
