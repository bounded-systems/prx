// `prx door bridge` — run the phase-1 loopback door-bridge (prx-8uf2): a
// 127.0.0.1-only TCP→unix forwarder for a door socket, authored once as a
// VerbSpec (projected to CLI / MCP / OpenAPI). Running it is the explicit opt-in
// the door-bridge ADR calls for; the loud startup line states the dev-only
// caveat (the edge is UNAUTHENTICATED — phase 2 adds the signed-grant gate).
import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { runLoopbackBridge, type LoopbackBridgeOptions } from "./bridge.ts";

export const DoorBridgeResult = z
  .object({
    port: z.number().describe("the loopback (127.0.0.1) TCP port the bridge listened on"),
    socket: z.string().describe("the door unix socket the bridge forwarded to"),
  })
  .strict();
export type DoorBridgeResult = z.infer<typeof DoorBridgeResult>;

export type DoorBridgeDeps = {
  bridge: (opts: LoopbackBridgeOptions) => ReturnType<typeof runLoopbackBridge>;
  log: (line: string) => void;
};

const realDoorBridgeDeps = (): DoorBridgeDeps => ({
  bridge: runLoopbackBridge,
  log: (line) => console.error(line),
});

export const doorBridgeVerb = defineVerb({
  id: "door bridge",
  summary:
    "Run a loopback (127.0.0.1) TCP→unix forwarder for a door socket — phase-1 door-bridge (prx-8uf2).",
  actor: "work",
  input: z.object({
    port: z
      .number()
      .int()
      .positive()
      .describe("loopback TCP port to listen on (bound to 127.0.0.1 only)"),
    socket: z.string().min(1).describe("door unix socket path to forward each connection to"),
    // Accepted for daemon-lifecycle uniformity (the generic launcher passes
    // --cwd to every serve command). The bridge is not repo-bound, so ignored.
    cwd: z.string().optional().describe("ignored — the bridge is not repo-bound"),
  }),
  output: DoorBridgeResult,
  deps: realDoorBridgeDeps,
  run: async (input, deps: DoorBridgeDeps = realDoorBridgeDeps()): Promise<DoorBridgeResult> => {
    const server = await deps.bridge({ port: input.port, socketPath: input.socket });
    // Loud, on purpose: this edge is UNAUTHENTICATED. Loopback keeps it off-host,
    // but it still widens the door from the socket's owner to all local users.
    deps.log(
      `door-bridge: 127.0.0.1:${input.port} → ${input.socket} ` +
        `(UNAUTHENTICATED loopback edge — dev-only; widens door access to all local users)`,
    );

    // Block until the process is terminated — the bridge runs until killed.
    await new Promise<void>((resolve) => server.on("close", () => resolve()));
    return { port: input.port, socket: input.socket };
  },
});
