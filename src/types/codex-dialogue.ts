import { z } from "zod";

export const codexDialogueDiagnosticsSchema = z.object({
  policyVersion: z.literal("codex-final-dialogue-v1"),
  retainedUsers: z.number().int().nonnegative(),
  retainedFinals: z.number().int().nonnegative(),
  completedTurns: z.number().int().nonnegative(),
  incompleteTurns: z.number().int().nonnegative(),
  orphanFinals: z.number().int().nonnegative(),
  truncated: z.boolean(),
  excluded: z.object({
    reasoning: z.number().int().nonnegative(),
    tool: z.number().int().nonnegative(),
    nonFinal: z.number().int().nonnegative(),
    context: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }),
  reasons: z.array(
    z.enum([
      "no_final_answer",
      "no_dialogue",
      "unsupported_format",
      "orphan_final",
      "ambiguous_turn",
    ]),
  ),
});

export type CodexDialogueDiagnostics = z.infer<typeof codexDialogueDiagnosticsSchema>;
