// GH-2401 (po05a.1) — the source→domain map: a typed producer table for every
// CAS-writing call site, plus the coverage seam that keeps it honest.
//
// Spike: docs/spikes/GH-2400-cas-domain-pinned-to-source.md. The invariant the
// spike establishes is **domain ⇒ provenance**: a CAS artifact's domain (its
// `<domain>://<sha>` prefix) is pinned to its *source* — the producing actor's
// service domain — not chosen freely by the caller. Today the domain is a free
// `writeBlob(content, { domain })` parameter that consults nothing (§1). This
// unit is the beachhead (§5.1): encode the producer table as a typed map and a
// coverage test, so every CAS write is attributable to a declared source. It
// ships **no behavior change** and is **storage-model-independent** — the
// pinning *mechanism* (lexical domain-bound handles, §2), the one-CAS + ref
// keystore storage model (§3, GH-2402), and the gc-layer reshape (§4, GH-2406)
// are sequenced follow-ons.
//
// This map is intentionally NOT the canonical domain vocabulary — that decision
// (service domains, where `scout`/`handoff` land, `submit` vs `publish`) is the
// `[NEEDS CLARIFICATION]` block in §3, ratified in po05a.5 (GH-2405). The
// `serviceDomain`/`catalogDomains` fields here are *documentary* rollups of the
// current tree (`src/machine/actors.ts`); only `domain` (the CAS prefix a
// producer writes today) and `callSite` are load-bearing for the coverage test.

/**
 * The CAS prefixes (artifact / source domains) written somewhere in the tree
 * today. These are the `<domain>://<sha>` namespaces — the axis gc aligns to
 * (spike §3 "artifact / source domain", internal).
 */
export const CAS_DOMAINS = ["plans", "submit", "scout", "handoff"] as const;
export type CasDomain = (typeof CAS_DOMAINS)[number];

/**
 * A producer whose written domain is resolved at runtime rather than fixed to a
 * single prefix — the dispatch handler writes a dispatched actor's stdout under
 * `{ domain: input.target }` (the target actor name) and refs it under
 * `dispatch:<source>:<id>`. This is the source-pinned precedent the spike
 * generalizes (§2): domain = the producing (target) actor, resolved per call.
 */
export const DYNAMIC_DOMAIN = "dynamic" as const;

/** The domain a producer writes: a fixed CAS prefix, or runtime-resolved. */
export type ProducerDomain = CasDomain | typeof DYNAMIC_DOMAIN;

/**
 * Sync / mirror domains (spike §3 "sync / mirror domain", external): the
 * `bd`/`gh`/`notion` mirror *targets*. They are orthogonal to where an artifact
 * is produced and must NEVER become a CAS prefix. The coverage test enforces
 * that no producer's `domain` collides with one of these.
 */
export const SYNC_MIRROR_DOMAINS = ["bd", "gh", "notion"] as const;
export type SyncMirrorDomain = (typeof SYNC_MIRROR_DOMAINS)[number];

/**
 * The shared kernel modules that DEFINE or generically forward the CAS write
 * primitives. They are not producers — their domain comes from the caller's
 * `opts` — so they are exempt from needing a producer-table entry, but the
 * coverage test still pins them so an accidental third primitive-definition
 * site is caught.
 *
 *   - `cas.ts`            defines `writeBlob` / `setRef` (and the readers).
 *   - `artifact-store.ts` defines `putArtifact` = `writeBlob` + `setRef`,
 *                         forwarding the caller's `{ domain }` unchanged.
 *
 * Paths are repo-root-relative POSIX.
 */
export const CAS_PRIMITIVE_MODULES = [
  "src/plan-store/cas.ts",
  "src/plan-store/artifact-store.ts",
] as const;

/** A single CAS-writing producer — one source pinned to one written domain. */
export interface CasProducer {
  /** Stable id for the producing concern (the "source"). */
  readonly source: string;
  /**
   * Repo-root-relative POSIX path of the module that calls a CAS write
   * primitive (`writeBlob` / `putArtifact` / `setRef`). The coverage test keys
   * off this — every such call site must appear here exactly once.
   */
  readonly callSite: string;
  /** The CAS prefix this producer writes today, or `dynamic` (see above). */
  readonly domain: ProducerDomain;
  /**
   * Documentary GH-2322 service-domain rollup (provisional, ratified in
   * GH-2405). The clean home for this source's artifacts under the one
   * source-anchored vocabulary the spike argues toward.
   */
  readonly serviceDomain: string;
  /**
   * Documentary fine-grained actor-catalog domains (`src/machine/actors.ts`
   * `domain:`) that roll up to `serviceDomain` for this source.
   */
  readonly catalogDomains: readonly string[];
  /** Free-text provenance / open-question note (e.g. the §3 clarifications). */
  readonly note?: string;
}

/**
 * THE source→domain map. Every CAS-writing call site in `src/` (other than the
 * {@link CAS_PRIMITIVE_MODULES} kernel) must be represented here. Adding a new
 * `writeBlob`/`putArtifact`/`setRef` call site without a matching entry fails
 * `test/plan-store/source-domain.test.ts` (the "no orphans" guard, spike
 * Verification §1).
 */
export const CAS_PRODUCERS: readonly CasProducer[] = [
  {
    source: "plan_store.save",
    callSite: "src/plan-store/verbs.ts",
    domain: "plans",
    serviceDomain: "plan",
    catalogDomains: ["planning_docs"],
    note:
      "`prx plan save` — writes the plan body blob + the PlanEnvelope artifact " +
      "(the DEFAULT_DOMAIN producer). §3 open question: rename prefix `plans`→`plan`.",
  },
  {
    source: "submit.artifact_writer",
    callSite: "src/submit/artifact.schema.ts",
    domain: "submit",
    serviceDomain: "submit",
    catalogDomains: ["ref_custody", "publication"],
    note:
      "keeper/publisher submit artifact + patch-blob writers " +
      "(`writeSubmitArtifact`/`writeSubmitPatchBlob`). Three catalog names " +
      "(ref_custody/publication) roll up to one `submit` source domain.",
  },
  {
    source: "submit.publish",
    callSite: "src/submit/publish.ts",
    domain: "submit",
    serviceDomain: "submit",
    catalogDomains: ["publication"],
    note:
      "publisher advances the published-slot ref into the `submit` domain. " +
      "§3 open question: `submit` vs `publish` service split (GH-2405).",
  },
  {
    source: "triage.prioritize_bulk",
    callSite: "src/triage/prioritize-bulk.ts",
    domain: "scout",
    serviceDomain: "triage",
    catalogDomains: ["task_graph"],
    note:
      "`prx triage prioritize-bulk` classifier batch blob. §3: `scout` is a " +
      "*capability* under triage/plan, not a standalone service (GH-2405).",
  },
  {
    source: "handoff.spill",
    callSite: "src/handoff/store.ts",
    domain: "handoff",
    serviceDomain: "implement",
    catalogDomains: ["bounded_code_change"],
    note:
      "`prx implement` dispatch-handoff arg spill (over the inline threshold). " +
      "§3: `handoff` is a *mechanism*, not a service (GH-2405).",
  },
  {
    source: "dispatch.handler",
    callSite: "src/pr-state/dispatch/handler.ts",
    domain: DYNAMIC_DOMAIN,
    serviceDomain: "dynamic",
    catalogDomains: [],
    note:
      "writes a dispatched actor's stdout under `{ domain: input.target }` and " +
      "refs `dispatch:<source>:<id>` — the runtime source-pinned precedent (§2) " +
      "the rest of the map generalizes. Domain = the target actor, per call.",
  },
  {
    source: "session.transition_pin",
    callSite: "src/session/transition-artifact.ts",
    domain: DYNAMIC_DOMAIN,
    serviceDomain: "dynamic",
    catalogDomains: [],
    note:
      "ai-home-wlw5l exit gate: pins a run's schema-validated transition " +
      "artifact under `{ domain: input.domain }` (the producing actor's service " +
      "domain) and refs `transition:<actor>:<unit>`. Validate-then-pin; domain = " +
      "the role per call, same dynamic precedent as dispatch.handler.",
  },
];

/** Producers (possibly more than one) that write a given CAS domain. */
export function producersForDomain(domain: ProducerDomain): CasProducer[] {
  return CAS_PRODUCERS.filter((p) => p.domain === domain);
}

/** The producer table entry for a call-site path, or `undefined`. */
export function producerForCallSite(callSite: string): CasProducer | undefined {
  return CAS_PRODUCERS.find((p) => p.callSite === callSite);
}

/** True if `callSite` is a declared producer OR a CAS primitive/kernel module. */
export function isDeclaredCasWriter(callSite: string): boolean {
  return (
    producerForCallSite(callSite) !== undefined ||
    (CAS_PRIMITIVE_MODULES as readonly string[]).includes(callSite)
  );
}
