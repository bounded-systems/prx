// `prx pod secrets` — provision (or report) the host podman secrets the pod's
// rooms declare. Run before `prx pod up`; closes the deploy last-mile (prx-z6ru)
// so secret creation is owned by the tool, not a manual `podman secret create`.
//
// With no `--from`, it's a doctor view: declared vs present vs missing-source.
// With `--from name=<@file|literal>` it provisions (idempotent; `--replace` rotates).
import { z } from "zod";
import { defineVerb } from "@bounded-systems/verbspec";

import { perRepoPod } from "./per-repo-pod.ts";
import { ensurePodSecrets, parseSource, type SecretSource } from "./pod-secrets.ts";

export const PodSecretsResult = z.object({
  pod: z.string(),
  secrets: z.array(
    z.object({
      name: z.string(),
      target: z.string(),
      room: z.string(),
      present: z.boolean(),
      action: z.enum(["created", "replaced", "exists", "missing-source"]),
    }),
  ),
});

export const podSecretsVerb = defineVerb({
  id: "pod secrets",
  summary: "Provision (or report) the host podman secrets the pod's rooms declare.",
  actor: "work",
  input: z.object({
    pod: z.enum(["per-repo"]).default("per-repo").describe("Pod spec (currently only 'per-repo')"),
    from: z
      .array(z.string())
      .default([])
      .describe("Source mapping name=<@/path/to/file | literal> (repeatable). @ → podman reads the file (the secret never enters prx); a literal is piped via stdin."),
    replace: z.boolean().default(false).describe("Replace (rotate) secrets that already exist"),
  }),
  output: PodSecretsResult,
  run: async ({ from, replace }) => {
    const spec = perRepoPod;
    const sources = new Map<string, SecretSource>();
    for (const entry of from) {
      const eq = entry.indexOf("=");
      if (eq <= 0) throw new Error(`--from must be name=source, got: ${entry}`);
      sources.set(entry.slice(0, eq), parseSource(entry.slice(eq + 1)));
    }
    return { pod: spec.name, secrets: ensurePodSecrets(spec, sources, { replace }) };
  },
});
