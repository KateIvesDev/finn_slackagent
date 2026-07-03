import type { Stance } from "./types.js";

// Single source of truth for Finn's reaction vocabulary.
// If you change a glyph here, the reaction arc, the verdict card, and FINN_DESIGN.md
// all stay in sync. Use Slack's reaction *names* (no colons), not the unicode char.

/** Added to every shark message the instant it posts. Jury's still out. */
export const THINKING = "thinking_face"; // 🤔

/** Finn's resolved read of an argument, mapped from Stance. */
export const STANCE_REACTION: Record<Stance, string> = {
  favored: "+1", // 👍 most compelling, weighing in favor
  overruled: "-1", // 👎 acknowledged but outweighed
  unresolved: "scales", // ⚖️ legitimate tension, needs synthesis — Slack's shortcode
  // for this glyph is "scales", not the gemoji/GitHub alias "balance_scale".
};

/** Human-readable label for the verdict card's per-shark read line. */
export const STANCE_LABEL: Record<Stance, string> = {
  favored: ":+1: weighed in favor",
  overruled: ":-1: acknowledged but outweighed",
  unresolved: ":scales: genuine tension",
};