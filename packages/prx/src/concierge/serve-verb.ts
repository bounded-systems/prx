// `prx concierge serve` — run concierged, the grant SOURCE (prx-8uf2/prx-9s14):
// providers register what they serve, consumers resolve a capability and get a
// signed grant the serving room's gate verifies. Authored once as a VerbSpec
// (projected to CLI / MCP / OpenAPI). The door-authority signing key is the
// keymaker per-actor key, held in-process; only its public half is published
// (the `keys` method).
import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { runConciergeServe, type ConciergeServer } from "./daemon.ts";

export const ConciergeServeResult = z
  .object({
    socket: z.string().describe("the unix socket the concierge listened on"),
  })
  .strict();
export type ConciergeServeResult = z.infer<typeof ConciergeServeResult>;

export type ConciergeServeDeps = {
  serve: typeof runConciergeServe;
  log: (line: string) => void;
};

const realConciergeServeDeps = (): ConciergeServeDeps => ({
  serve: runConciergeServe,
  log: (line) => console.error(line),
});

export const conciergeServeVerb = defineVerb({
  id: "concierge serve",
  summary: "Run concierged — register/resolve/keys/list grant broker (prx-8uf2).",
  actor: "work",
  input: z.object({
    socket: z.string().min(1).describe("unix socket path the concierge listens on"),
    pidfile: z.string().optional().describe("write the daemon pid here (removed on close)"),
    // Accepted for daemon-lifecycle uniformity (the generic launcher passes --cwd
    // to every serve command). concierged is not repo-bound, so this is ignored.
    cwd: z.string().optional().describe("ignored — concierged is not repo-bound"),
  }),
  output: ConciergeServeResult,
  deps: realConciergeServeDeps,
  run: async (
    input,
    deps: ConciergeServeDeps = realConciergeServeDeps(),
  ): Promise<ConciergeServeResult> => {
    const server: ConciergeServer = await deps.serve({
      socketPath: input.socket,
      ...(input.pidfile ? { pidfile: input.pidfile } : {}),
    });
    deps.log(`concierged: listening on ${input.socket}`);
    // Block until the process is terminated — the daemon runs until killed.
    await server.closed;
    return { socket: input.socket };
  },
});
