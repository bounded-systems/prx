// `prx pod down` — tear a pod down (kube down the non-secret rooms + rm the
// secret-room containers). The counterpart to `prx pod up`; `playPod`'s no-op
// message already points here ("run `prx pod down` first to recreate"). Lets the
// redeploy be `prx pod down && prx pod up` (or `prx pod up --recreate`) instead
// of dropping to raw `podman pod rm`.
import { z } from "zod";
import { defineVerb } from "@bounded-systems/verbspec";

import { downPod } from "./podman-runtime.ts";
import { perRepoPod } from "./per-repo-pod.ts";

export const PodDownResult = z.object({
  pod: z.string().describe("Pod name that was torn down"),
  commands: z.number().describe("Number of podman commands run to tear the pod down"),
});

export const podDownVerb = defineVerb({
  id: "pod down",
  summary: "Tear a pod down (kube down + rm secret-room containers).",
  actor: "work",
  input: z.object({
    pod: z.enum(["per-repo"]).default("per-repo").describe("Pod spec (currently only 'per-repo')"),
  }),
  output: PodDownResult,
  run: async ({ pod }) => {
    const base = pod === "per-repo" ? perRepoPod : perRepoPod;
    const spec = { ...base, repo: process.cwd() };
    const results = downPod(spec);
    return { pod: spec.name, commands: results.length };
  },
});
