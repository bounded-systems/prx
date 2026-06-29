// `prx door grant` + `prx door issuer-keys` (prx-8uf2) — the issuer surface that
// closes the loop with the keeperd TCP gate (`src/keeperd/grant-gate.ts`):
//   - `door issuer-keys` emits the published IssuerKeys to configure on a door
//     (e.g. `KEEPERD_ISSUER_KEYS`), so it can verify grants this issuer mints.
//   - `door grant` mints a short-lived, audience-bound SignedGrant a caller
//     presents to that door's TCP edge.
// Both authored once as VerbSpecs (projected to CLI / MCP / OpenAPI).
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import {
  DEFAULT_GRANT_ISSUER_ACTOR,
  issuerKeys,
  mintDoorGrant,
  type MintGrantInput,
} from "./grant-issuer.ts";

// ── prx door issuer-keys ─────────────────────────────────────────────────────

export const IssuerKeysResult = z
  .object({
    keys: z
      .array(z.object({ kid: z.string(), publicKeyPem: z.string() }).strict())
      .describe("the published issuer verification keys (configure on the door)"),
  })
  .strict();
export type IssuerKeysResult = z.infer<typeof IssuerKeysResult>;

export type IssuerKeysDeps = { resolve: typeof issuerKeys };
const realIssuerKeysDeps = (): IssuerKeysDeps => ({ resolve: issuerKeys });

export const doorIssuerKeysVerb = defineVerb({
  id: "door issuer-keys",
  summary:
    "Emit the published IssuerKeys for a door authority (configure on a door to verify its grants).",
  actor: "work",
  input: z.object({
    actor: z
      .string()
      .min(1)
      .default(DEFAULT_GRANT_ISSUER_ACTOR)
      .describe("the door-authority actor whose public key is published"),
  }),
  output: IssuerKeysResult,
  deps: realIssuerKeysDeps,
  run: async (input, deps: IssuerKeysDeps = realIssuerKeysDeps()): Promise<IssuerKeysResult> =>
    deps.resolve(input.actor),
});

// ── prx door grant ───────────────────────────────────────────────────────────

export const DoorGrantResult = z
  .object({
    door: z.string().describe("the door the grant authorizes"),
    audience: z.string().describe("the room id permitted to present it"),
    expiresAt: z.number().describe("grant expiry, epoch ms"),
    grant: z.unknown().describe("the SignedGrant to present to the door's TCP edge"),
  })
  .strict();
export type DoorGrantResult = z.infer<typeof DoorGrantResult>;

export type DoorGrantDeps = {
  mint: typeof mintDoorGrant;
  now: () => number;
  nonce: () => string;
};
const realDoorGrantDeps = (): DoorGrantDeps => ({
  mint: mintDoorGrant,
  now: () => Date.now(),
  nonce: () => randomUUID(),
});

export const doorGrantVerb = defineVerb({
  id: "door grant",
  summary: "Mint a short-lived, audience-bound signed grant for a door (prx-8uf2).",
  actor: "work",
  input: z.object({
    door: z.string().min(1).describe("the door the grant authorizes (e.g. keeper)"),
    audience: z.string().min(1).describe("the room id permitted to present the grant"),
    ttl: z
      .number()
      .int()
      .positive()
      .default(60)
      .describe("grant lifetime in seconds (keep short — per-lease)"),
    actor: z
      .string()
      .min(1)
      .default(DEFAULT_GRANT_ISSUER_ACTOR)
      .describe("the door-authority actor that signs the grant"),
  }),
  output: DoorGrantResult,
  deps: realDoorGrantDeps,
  run: async (input, deps: DoorGrantDeps = realDoorGrantDeps()): Promise<DoorGrantResult> => {
    const now = deps.now();
    const mintInput: MintGrantInput = {
      door: input.door,
      audience: input.audience,
      ttlSeconds: input.ttl,
      nonce: deps.nonce(),
      now,
      actor: input.actor,
    };
    const grant = deps.mint(mintInput);
    return {
      door: input.door,
      audience: input.audience,
      expiresAt: now + input.ttl * 1000,
      grant,
    };
  },
});
