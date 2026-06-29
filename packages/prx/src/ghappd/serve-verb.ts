// `prx ghapp serve` — run ghappd (the GitHub App credential-broker door) on a
// unix socket, as a spec-driven VerbSpec (authored once → projected to CLI / MCP
// / OpenAPI, no hand-wired registry/openapi/actor coupling). Mirrors podUpVerb's
// infra shape; the App key is resolved host-side via resolveBrokerConfig and held
// in the daemon, never leaving the door.
import { readFileSync } from "node:fs";

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { resolveBrokerConfig } from "../github-app/broker-config.ts";
import { runGhappdServe, type GhappdDaemonDeps } from "./daemon.ts";

export const GhappServeResult = z
  .object({
    socket: z.string().describe("the unix socket the door listened on"),
    configured: z.boolean().describe("whether an App key was resolved (else leases error)"),
  })
  .strict();
export type GhappServeResult = z.infer<typeof GhappServeResult>;

export type GhappServeDeps = {
  resolveConfig: typeof resolveBrokerConfig;
  readFile: (path: string) => string;
  serve: typeof runGhappdServe;
  log: (line: string) => void;
};

const realGhappServeDeps = (): GhappServeDeps => ({
  resolveConfig: resolveBrokerConfig,
  readFile: (path) => readFileSync(path, "utf8"),
  serve: runGhappdServe,
  log: (line) => console.error(line),
});

export const ghappServeVerb = defineVerb({
  id: "ghapp serve",
  summary: "Run the ghappd GitHub App credential-broker door on a unix socket.",
  actor: "work",
  input: z.object({
    socket: z.string().min(1).describe("unix socket path the door listens on"),
    pidfile: z.string().optional().describe("write the daemon pid here (removed on close)"),
    // Accepted for daemon-lifecycle uniformity (the generic Lima/pod launcher
    // passes --cwd to every serve command). ghappd is NOT repo-bound — it holds
    // a key and serves — so this is ignored.
    cwd: z.string().optional().describe("ignored — ghappd is not repo-bound"),
  }),
  output: GhappServeResult,
  deps: realGhappServeDeps,
  run: async (
    input,
    deps: GhappServeDeps = realGhappServeDeps(),
  ): Promise<GhappServeResult> => {
    // The App key is resolved host-side (inline PEM or key file) and held by the
    // daemon. Absent ⇒ the door still serves but every lease replies error
    // (so a misconfigured host fails loudly at lease time, not at startup).
    const config = deps.resolveConfig({ readFile: deps.readFile });
    const daemonDeps: GhappdDaemonDeps = config
      ? {
          config: {
            issuer: config.issuer,
            privateKeyPem: config.privateKeyPem,
            installationId: config.installationId,
          },
        }
      : {};

    const server = await deps.serve({
      socketPath: input.socket,
      ...(input.pidfile ? { pidfile: input.pidfile } : {}),
      deps: daemonDeps,
    });
    deps.log(
      `ghappd: listening on ${input.socket}${config ? "" : " (no App key configured — leases will error)"}`,
    );

    // Block until the process is terminated — the daemon runs until killed.
    await server.closed;
    return { socket: input.socket, configured: config !== null };
  },
});
