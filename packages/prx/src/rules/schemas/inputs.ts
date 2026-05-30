// GH-1423: typed inputs to the `rules` actor.
//
// Each schema describes one slice of substrate the renderer projects into
// `claude/rules/*.md`. PR-1 wires only `VerbSupply`; the other three are
// declared so the renderer can be developed against a partial substrate
// without churning the schema layer when each loader lands.
//
// Source-of-truth pointers (per `docs/prx/rules-build-substrate.md` §3.5):
//   verb-supply       → src/cli/registry.data.ts (prxCommandRegistry)
//   alias-supply      → future nix/home-manager/...-zsh-aliases module
//   worktree-gestures → nix/home-manager/worktrunk.nix + prx worktree machine
//   memory-index      → project-level MEMORY.md (not user-level)

import { z } from "zod";

import { ActorName } from "../../cli/registry.ts";

export const verbSupplyEntrySchema = z.object({
  name: z.string().min(1),
  parent: z.string().min(1).optional(),
  actor: ActorName,
});
export type VerbSupplyEntry = z.infer<typeof verbSupplyEntrySchema>;

export const verbSupplySchema = z.array(verbSupplyEntrySchema);
export type VerbSupply = z.infer<typeof verbSupplySchema>;

export const aliasSourceSchema = z.enum(["nix", "shell-rc"]);
export type AliasSource = z.infer<typeof aliasSourceSchema>;

export const aliasSupplyEntrySchema = z.object({
  name: z.string().min(1),
  target: z.string().min(1),
  source: aliasSourceSchema,
});
export type AliasSupplyEntry = z.infer<typeof aliasSupplyEntrySchema>;

export const aliasSupplySchema = z.array(aliasSupplyEntrySchema);
export type AliasSupply = z.infer<typeof aliasSupplySchema>;

export const worktreeGestureEntrySchema = z.object({
  name: z.string().min(1),
  prx_verb: z.string().min(1),
  description: z.string().min(1),
});
export type WorktreeGestureEntry = z.infer<typeof worktreeGestureEntrySchema>;

export const worktreeGesturesSchema = z.array(worktreeGestureEntrySchema);
export type WorktreeGestures = z.infer<typeof worktreeGesturesSchema>;

export const memoryIndexTypeSchema = z.enum([
  "user",
  "feedback",
  "project",
  "reference",
]);
export type MemoryIndexType = z.infer<typeof memoryIndexTypeSchema>;

export const memoryIndexEntrySchema = z.object({
  slug: z.string().min(1),
  file: z.string().min(1),
  type: memoryIndexTypeSchema,
});
export type MemoryIndexEntry = z.infer<typeof memoryIndexEntrySchema>;

export const memoryIndexSchema = z.array(memoryIndexEntrySchema);
export type MemoryIndex = z.infer<typeof memoryIndexSchema>;

export type RulesInputKind =
  | "verb-supply"
  | "alias-supply"
  | "worktree-gestures"
  | "memory-index";

export type RulesInputs = {
  verbSupply: VerbSupply;
  aliasSupply: AliasSupply;
  worktreeGestures: WorktreeGestures;
  memoryIndex: MemoryIndex;
};
