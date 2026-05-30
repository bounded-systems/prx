import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { prSkillNames } from "./machine.ts";
import { toolActors } from "./actors.ts";

const EXTRA_KNOWN_ACTORS = [
  "codex",
  "claude-code",
  "gemini-cli",
  "agent.executor",
  "agent.planner",
  "agent.tester",
  "agent.reviewer",
] as const;

export const KNOWN_ACTORS: ReadonlySet<string> = new Set([
  ...prSkillNames,
  ...toolActors,
  ...EXTRA_KNOWN_ACTORS,
]);

const transitionEntrySchema = z.object({
  id: z.string(),
  issue: z.string().nullable(),
  state_from: z.string(),
  state_to: z.string(),
  actor: z.string(),
  artifact: z.string().nullable(),
  timestamp: z.string(),
  proof: z
    .object({
      commit: z.string().nullable().optional(),
      checks: z.array(z.string()).optional(),
    })
    .optional(),
});

export type TransitionEntry = z.infer<typeof transitionEntrySchema>;

export function readTransitionLog(logPath: string): TransitionEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => transitionEntrySchema.parse(JSON.parse(line)));
}

export function appendTransitionLog(logPath: string, entry: TransitionEntry): void {
  if (existsSync(logPath)) {
    const existing = readTransitionLog(logPath);
    if (existing.some((e) => e.id === entry.id)) return;
  }
  // Create the parent dir (e.g. .prx/) so a fresh checkout doesn't ENOENT.
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function validateActorOwnership(actor: string): void {
  if (!KNOWN_ACTORS.has(actor)) {
    throw new Error(
      `unknown actor \`${actor}\`; must be one of: ${[...KNOWN_ACTORS].sort().join(", ")}`,
    );
  }
}
