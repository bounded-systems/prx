// `prx sync serve` — run the SYNC AGENT (prx-697): a long-running daemon that
// every `--interval` seconds reconciles every inventory repo (domain↔GH + dolt
// push/pull) so beads durability doesn't depend on anyone running a sync by hand.
// Authored once as a VerbSpec (projected to CLI / MCP / OpenAPI). Mirrors
// forgeServeVerb's infra shape; the reconcile logic lives in runSyncServe (the
// loop) over the existing, tested cross-repo orchestrators.

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";

import { runSyncServe, DEFAULT_SYNC_INTERVAL_MS, type SyncServeHandle } from "./serve.ts";

export const SyncServeResult = z
  .object({
    intervalSeconds: z.number().describe("the cross-repo reconcile interval the agent ran at"),
  })
  .strict();
export type SyncServeResult = z.infer<typeof SyncServeResult>;

export type SyncServeVerbDeps = {
  serve: typeof runSyncServe;
  log: (line: string) => void;
};

const realSyncServeDeps = (): SyncServeVerbDeps => ({
  serve: runSyncServe,
  log: (line) => console.error(line),
});

export const syncServeVerb = defineVerb({
  id: "sync serve",
  summary: "Run the sync agent: periodically reconcile every inventory repo (beads + dolt).",
  actor: "work",
  input: z.object({
    interval: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`seconds between cross-repo reconcile passes (default ${DEFAULT_SYNC_INTERVAL_MS / 1000})`),
    pidfile: z.string().optional().describe("write the daemon pid here (removed on close)"),
    // Accepted for daemon-lifecycle uniformity (the generic launcher passes --cwd
    // to every serve command). The sync agent is host-global / cross-repo, not
    // repo-bound, so this is ignored.
    cwd: z.string().optional().describe("ignored — the sync agent is not repo-bound"),
  }),
  output: SyncServeResult,
  deps: realSyncServeDeps,
  run: async (input, deps: SyncServeVerbDeps = realSyncServeDeps()): Promise<SyncServeResult> => {
    const intervalSeconds = input.interval ?? DEFAULT_SYNC_INTERVAL_MS / 1000;
    const handle: SyncServeHandle = await deps.serve({
      intervalMs: intervalSeconds * 1000,
      ...(input.pidfile ? { pidfile: input.pidfile } : {}),
    });
    deps.log(`sync agent: reconciling every inventory repo every ${intervalSeconds}s`);
    // Block until terminated — the daemon runs until killed (SIGTERM/SIGINT).
    await handle.closed;
    return { intervalSeconds };
  },
});
