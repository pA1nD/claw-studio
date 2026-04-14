/**
 * Claw CLI theme — warm, precise, terminal-native.
 *
 * These colour values are consumed by Ink components via the `color` prop.
 * Ink maps hex values to the nearest supported terminal colour automatically.
 */
export const theme = {
  /** Amber — primary brand colour. */
  brand: "#F59E0B",
  /** Red — error and halted states. */
  error: "#EF4444",
  /** Green — success and approvals. */
  success: "#22C55E",
  /** Grey — secondary text, hints, flags. */
  muted: "#6B7280",
  /** Near-white — primary text. */
  text: "#F9FAFB",
} as const;

/** Type of the exported theme. */
export type Theme = typeof theme;
