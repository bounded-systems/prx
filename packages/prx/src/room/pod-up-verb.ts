// `prx pod up` — launch a pod and attest its launch (the L2 capability chain).
// First live caller of `launchPod`; the `playPod` lifecycle hook's entry point.

import { z } from "zod";
import { defineVerb } from "@bounded-systems/verbspec";

import { launchPod } from "./podman-runtime.ts";
import { perRepoPod } from "./per-repo-pod.ts";

export const PodUpResult = z.object({
  pod: z.string().describe("Pod name that was launched"),
  containers: z.number().describe("Number of podman commands run (provision + rooms)"),
  l2LaunchDigest: z
    .string()
    .nullable()
    .describe(
      "Content-address of the stored L2 launch attestation, or null if the pod has no keeper door",
    ),
});

export const podUpVerb = defineVerb({
  id: "pod up",
  summary: "Launch a pod and attest its launch (capability chain).",
  actor: "work",
  input: z.object({
    pod: z
      .enum(["per-repo"])
      .default("per-repo")
      .describe("Pod spec to launch (currently only 'per-repo')"),
  }),
  output: PodUpResult,
  run: async ({ pod }) => {
    const base = pod === "per-repo" ? perRepoPod : perRepoPod;
    const spec = { ...base, repo: process.cwd() };
    const { results, l2LaunchDigest } = await launchPod(spec);
    return {
      pod: spec.name,
      containers: results.length,
      l2LaunchDigest: l2LaunchDigest ?? null,
    };
  },
});
