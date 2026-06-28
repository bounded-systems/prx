// ghappd wire contract (spec: claude-box/GHAPPD.md, prx-cdln). ghappd is the
// GitHub App credential-broker door: it holds the App private key and serves a
// `lease` op that returns a short-lived installation token. The caller never
// holds the PEM. Sibling of beadsd/keeperd — same framed-socket dispatch.
import { z } from "zod";

/**
 * A lease request. Optional `repositories`/`permissions` attenuate the minted
 * token (GitHub `access_tokens` body); omitted → the installation's full scopes.
 * (Door-level flooring of what a guest may request is a later phase; GitHub
 * already caps requests to the installation's grant.)
 */
export const GhappdRequestSchema = z.object({
  kind: z.literal("lease"),
  repositories: z.array(z.string().min(1)).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
});
export type GhappdRequest = z.infer<typeof GhappdRequestSchema>;

/** Response discriminates on `status`. `ok.token` is a secret — never logged. */
export const GhappdResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    token: z.string().min(1),
    expiresAt: z.string().min(1),
    permissions: z.record(z.string(), z.string()),
  }),
  z.object({
    status: z.literal("error"),
    code: z.string().min(1),
    message: z.string(),
  }),
]);
export type GhappdResponse = z.infer<typeof GhappdResponseSchema>;
