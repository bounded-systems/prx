/**
 * Spike — eval-gated prompt evolution as a signed derivation
 * ==========================================================
 *
 * Combines two ideas (see docs/prx/signed-self-improvement.md):
 *   1. Eval-gated self-improvement (prior art: the "long-running-agent" / lra project):
 *      propose an improved prompt from failure traces, score candidate vs baseline on
 *      gold cases, promote only if it wins, and never hot-patch a live prompt.
 *   2. Signed promotion (prx's anchored-chain): the promotion itself is a signed
 *      Derivation. The live prompt registry refuses to swap in a candidate unless it is
 *      presented with a promotion whose ed25519 signature verifies over the canonical
 *      manifest. "No signed promotion -> no swap" — the ocap rule applied to evolution.
 *
 * lra content-addresses (SHA-256) but does not sign. Signing makes the promotion an
 * unforgeable capability, cryptographically bound to its inputs (baseline prompt +
 * failure traces + eval report) and its output (the candidate prompt).
 *
 * Everything is deterministic + offline ($0): stub evolver, stub judge, real ed25519.
 *
 * Run (bun on PATH):  bun docs/spikes/signed-prompt-evolution/poc.ts
 */

import {
  type Derivation,
  type Digest,
  type DsseEnvelope,
  canonicalJson,
  digestManifest,
  dssePae,
  DSSE_PAYLOAD_TYPE,
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  sha256Hex,
} from "@bounded-systems/anchored-chain";

const log = (line: string) => console.log(line);
const d = (s: string): Digest => sha256Hex(s);

// ---------------------------------------------------------------------------
// 1. The self-improvement loop (borrowed from lra, deterministic stub)
// ---------------------------------------------------------------------------

/** Distil failure traces into standing rules and append them — the stub "evolver". */
function proposeCandidate(currentPrompt: string, failureTraces: readonly string[]): string {
  const lessons = failureTraces
    .map((t) => `- LESSON: ${t}`)
    .join("\n");
  return `${currentPrompt}\n\n# Standing rules learned from failures\n${lessons}`;
}

/** A gold eval case: the rubric passes iff the prompt embeds the required keyword. */
type GoldCase = { name: string; requires: string };

/** Deterministic stub judge — fail-closed: a missing keyword is a fail. */
function evalPassRate(prompt: string, cases: readonly GoldCase[]): number {
  const passed = cases.filter((c) => prompt.toLowerCase().includes(c.requires.toLowerCase()));
  return cases.length === 0 ? 0 : passed.length / cases.length;
}

// ---------------------------------------------------------------------------
// 2. The signed promotion (prx's moat — real anchored-chain Derivation)
// ---------------------------------------------------------------------------

type Promotion = { derivation: Derivation; envelope: DsseEnvelope; candidatePrompt: string };

/** Mint a signed promotion derivation binding inputs → candidate output. */
async function mintSignedPromotion(args: {
  baselinePrompt: string;
  failureTraces: readonly string[];
  evalReport: object;
  candidatePrompt: string;
  signer: ReturnType<typeof ed25519Signer>;
  keyid: string;
}): Promise<Promotion> {
  const manifest: Derivation["manifest"] = {
    producer: "evolver",
    inputs: {
      baselinePrompt: d(args.baselinePrompt),
      failureTraces: d(canonicalJson(args.failureTraces)),
      evalReport: d(canonicalJson(args.evalReport)),
    },
    outputs: { candidatePrompt: d(args.candidatePrompt) },
    contracts: ["eval-gated-promotion@1"],
    params: { minImprovement: 0 },
  };
  const derivationId = digestManifest(manifest);
  const derivation: Derivation = { derivationId, manifest, ts: 0 };

  // Sign the canonical manifest via the real DSSE pre-auth encoding.
  const payload = canonicalJson(manifest);
  const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode(payload));
  const sig = await args.signer.sign(pae);
  const envelope: DsseEnvelope = {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64"),
    signatures: [sig],
  };
  return { derivation, envelope, candidatePrompt: args.candidatePrompt };
}

// ---------------------------------------------------------------------------
// 3. The live prompt registry — "no signed promotion → no swap"
// ---------------------------------------------------------------------------

class LivePromptRegistry {
  constructor(
    private prompt: string,
    private readonly verifier: ReturnType<typeof ed25519Verifier>,
  ) {}

  current(): string {
    return this.prompt;
  }

  /** Swap in the candidate ONLY if the promotion verifies AND binds this exact output. */
  async tryPromote(p: Promotion): Promise<{ ok: boolean; reason: string }> {
    const payload = canonicalJson(p.derivation.manifest);
    const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode(payload));
    const sig = p.envelope.signatures[0];
    if (!sig) return { ok: false, reason: "no signature" };

    const verified = await this.verifier.verify(pae, sig);
    if (!verified) return { ok: false, reason: "signature does not verify" };

    // The output digest in the signed manifest must match the prompt being installed.
    if (p.derivation.manifest.outputs.candidatePrompt !== d(p.candidatePrompt)) {
      return { ok: false, reason: "candidate prompt does not match signed output digest" };
    }
    this.prompt = p.candidatePrompt;
    return { ok: true, reason: `installed (derivation ${p.derivation.derivationId.slice(0, 12)}…)` };
  }
}

// ---------------------------------------------------------------------------
// 4. Demo — lra-style trace
// ---------------------------------------------------------------------------

async function main() {
  const { privateKey, publicKey, keyid } = generateEd25519Keypair();
  const signer = ed25519Signer(privateKey, keyid);
  const verifier = ed25519Verifier(publicKey);

  const baseline = "You are the Lead Engineer. Implement the LSP server.";
  const registry = new LivePromptRegistry(baseline, verifier);

  const failureTraces = [
    "wire-protocol framing is byte-level; isolate and unit-test it FIRST",
    "never fix 3 entangled problems in one file; split them",
  ] as const;

  const gold: GoldCase[] = [
    { name: "framing-first", requires: "unit-test it FIRST" },
    { name: "split-concerns", requires: "split them" },
  ];

  log("── eval-gated, signed prompt evolution ─────────────────────────────");
  log(`keyid=${keyid.slice(0, 16)}…  cases=${gold.length}`);

  // -- Round A: a candidate that DOES beat baseline ------------------------
  const candidate = proposeCandidate(baseline, failureTraces);
  const baselineRate = evalPassRate(baseline, gold);
  const candRate = evalPassRate(candidate, gold);
  const report = { baseline: baselineRate, candidate: candRate };
  log(`\neval.run        baseline=${baselineRate.toFixed(2)} candidate=${candRate.toFixed(2)}`);

  const promoted = candRate >= baselineRate; // minImprovement = 0
  log(`promotion.gate  ${promoted ? "PASS" : "REJECT"} (candidate ${promoted ? ">=" : "<"} baseline)`);

  if (promoted) {
    const promo = await mintSignedPromotion({
      baselinePrompt: baseline,
      failureTraces,
      evalReport: report,
      candidatePrompt: candidate,
      signer,
      keyid,
    });
    log(`evolve.sign     derivation=${promo.derivation.derivationId.slice(0, 12)}… signed`);

    const r = await registry.tryPromote(promo);
    log(`registry.swap   ${r.ok ? "OK" : "DENIED"} — ${r.reason}`);

    // -- Tamper test: forge a different candidate under the signed envelope --
    const forged = { ...promo, candidatePrompt: candidate + "\n# sneaky injected rule" };
    const t = await registry.tryPromote(forged);
    log(`tamper.attempt  ${t.ok ? "OK" : "DENIED"} — ${t.reason}`);

    // -- Forged signature: sign with a DIFFERENT key ------------------------
    const evil = generateEd25519Keypair();
    const evilPromo = await mintSignedPromotion({
      baselinePrompt: baseline,
      failureTraces,
      evalReport: report,
      candidatePrompt: candidate,
      signer: ed25519Signer(evil.privateKey, evil.keyid),
      keyid: evil.keyid,
    });
    const e = await registry.tryPromote(evilPromo);
    log(`forged.key      ${e.ok ? "OK" : "DENIED"} — ${e.reason}`);
  }

  // -- Round B: a candidate that does NOT beat baseline → no promotion ------
  const weakTraces = ["use more comments"] as const;
  const weak = proposeCandidate(baseline, weakTraces);
  const weakRate = evalPassRate(weak, gold);
  log(`\neval.run        baseline=${baselineRate.toFixed(2)} weak=${weakRate.toFixed(2)}`);
  const weakPromoted = weakRate > baselineRate;
  log(`promotion.gate  ${weakPromoted ? "PASS" : "REJECT"} — no signature minted, no swap`);

  log("\n── final ───────────────────────────────────────────────────────────");
  log(`live prompt advanced: ${registry.current() !== baseline}`);
  log(registry.current().includes("sneaky") ? "!! INJECTION LANDED" : "clean: no unsigned mutation reached the live prompt");
}

void main();
