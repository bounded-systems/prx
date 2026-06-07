// `prx provenance status` — the onboarding surface (GH-352).
//
// prx deployed in a dev environment IS production for prx, so signing is the
// identity layer. This reports the live signing posture and, when it is not the
// production configuration, bubbles up the exact onboarding steps — so a missing
// or stale setup is discoverable from inside the tool, not just the docs.
//
// Pure over its inputs (the CLI resolves them from the env / trust map / drift);
// the posture + onboarding copy is decided here so it can be unit-tested.

export interface ProvenanceStatusInputs {
  /** Per-actor signing (each actor signs with its own master-derived key). */
  readonly perActor: boolean;
  /** Where the signing master comes from. */
  readonly masterSource: "operator-file" | "config-file" | "dev-bootstrap";
  /** How many actors are pinned in the public trust map. */
  readonly trustedActors: number;
  /** Trust-map drift: actors whose derived key no longer matches the published one. */
  readonly drift: ReadonlyArray<{ readonly actor: string; readonly reason: string }>;
  /** Fail-closed verification is on (`PRX_REQUIRE_SIGNED_DERIVATIONS`). */
  readonly enforced: boolean;
}

export type ProvenancePosture = "production" | "bootstrap" | "drifted" | "unconfigured";

export interface ProvenanceStatus extends ProvenanceStatusInputs {
  readonly posture: ProvenancePosture;
  readonly summary: string;
  /** Actionable next steps; empty when already production. */
  readonly onboarding: readonly string[];
}

const SETUP = "packages/prx/scripts/setup-provenance-signing";
const DOCS = "docs/provenance/signing.md";

export function provenanceStatus(inputs: ProvenanceStatusInputs): ProvenanceStatus {
  const operatorMaster =
    inputs.masterSource === "operator-file" || inputs.masterSource === "config-file";
  const hasTrust = inputs.trustedActors > 0;
  // Drift means the PUBLISHED map is stale — not an empty map that was never
  // registered (keymaker reports every actor as "missing" against an empty map).
  const drifted = hasTrust && inputs.drift.length > 0;

  let posture: ProvenancePosture;
  if (drifted) posture = "drifted";
  else if (operatorMaster && hasTrust && inputs.enforced && inputs.perActor) posture = "production";
  else if (inputs.masterSource === "dev-bootstrap" && inputs.perActor) posture = "bootstrap";
  else posture = "unconfigured";

  return {
    ...inputs,
    posture,
    summary: summaryFor(posture),
    onboarding: onboardingFor(posture, inputs),
  };
}

function summaryFor(posture: ProvenancePosture): string {
  switch (posture) {
    case "production":
      return "production — operator master, per-actor trust map, fail-closed verification.";
    case "bootstrap":
      return "bootstrap — signing with the zero-config dev master (per-machine, not the operator identity).";
    case "drifted":
      return "DRIFTED — the published trust map no longer matches the master's derived keys.";
    case "unconfigured":
      return "not configured — signing is not active in the production posture.";
  }
}

function onboardingFor(
  posture: ProvenancePosture,
  inputs: ProvenanceStatusInputs,
): readonly string[] {
  if (posture === "production") return [];
  if (posture === "drifted") {
    return [
      `Re-publish the trust map: \`${SETUP}\` (or \`prx keymaker register\`).`,
      "Commit the updated ~/.config/prx/config.json (provenance.trust).",
    ];
  }
  const steps: string[] = [];
  if (inputs.masterSource === "dev-bootstrap") {
    steps.push(
      "Point at the operator master: set `programs.prx.provenance.masterFile` (an agenix/sops secret) + `requireSigned = true`, then `home-manager switch`.",
    );
  }
  if (!inputs.perActor) {
    steps.push("Enable per-actor signing: `export PRX_PROVENANCE_KEY=dev`.");
  }
  if (inputs.trustedActors === 0 || posture === "unconfigured") {
    steps.push(`Publish per-actor keys: \`${SETUP}\` (runs \`keymaker register\` + verifies).`);
  }
  if (!inputs.enforced) {
    steps.push("Turn on fail-closed verification: `export PRX_REQUIRE_SIGNED_DERIVATIONS=1`.");
  }
  steps.push(`See ${DOCS}.`);
  return steps;
}

/** Render the status for the CLI (plain text). */
export function renderProvenanceStatus(status: ProvenanceStatus): string[] {
  const lines = [
    `provenance signing: ${status.posture}`,
    `  ${status.summary}`,
    `  mode:        ${status.perActor ? "per-actor" : "single-key / off"}`,
    `  master:      ${status.masterSource}`,
    `  trust map:   ${status.trustedActors} actor(s)${
      status.trustedActors > 0 && status.drift.length > 0 ? ` — ${status.drift.length} drifted` : ""
    }`,
    `  enforcement: ${status.enforced ? "on (fail-closed)" : "off"}`,
  ];
  if (status.onboarding.length > 0) {
    lines.push("", "onboarding:");
    for (const step of status.onboarding) lines.push(`  - ${step}`);
  }
  return lines;
}
