import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createActor, waitFor } from "xstate";
import { ed25519Signer, ed25519Verifier, generateEd25519Keypair } from "@bounded-systems/anchored-chain";

import type { NonInteractiveAgentResult } from "../claude/agent_service.ts";
import { createPilotMachine } from "../machine/machines/pilot.ts";
import { verifyLeg } from "../machine/machines/pilot-signing.ts";
import {
  buildRealCiGate,
  buildRealMerge,
  buildRealPilotDeps,
  parseCiConclusion,
  type OpenSessionFn,
  type RunAgentFn,
  type RunPrx,
} from "./pilot-real.ts";

const noSleep = async () => {};
const newSigner = () => {
  const kp = generateEd25519Keypair();
  return { kp, signer: ed25519Signer(kp.privateKey, kp.keyid) };
};

describe("real CI gate + merge tail", () => {
  test("parseCiConclusion maps scout statuses", () => {
    expect(parseCiConclusion('{"conclusion":"success"}')).toBe("success");
    expect(parseCiConclusion('{"status":"failure"}')).toBe("failure");
    expect(parseCiConclusion('{"state":"in_progress"}')).toBe("pending");
    expect(parseCiConclusion("not json")).toBe("unknown");
  });

  test("green CI settles and signs a verifiable gate link", async () => {
    const { kp, signer } = newSigner();
    const out = '{"conclusion":"success"}';
    const runPrx: RunPrx = async () => ({ ok: true, stdout: out, stderr: "" });
    const { passed, attestation } = await buildRealCiGate({ runPrx, signer })({ workUnitId: "GH-1" });

    expect(passed).toBe(true);
    expect(attestation.predicate).toBe("ci.passed");
    const hash = createHash("sha256").update(out).digest("hex");
    expect(await verifyLeg(ed25519Verifier(kp.publicKey), attestation, hash)).toBe(true);
  });

  test("red CI → passed:false (no merge edge taken)", async () => {
    const { signer } = newSigner();
    const runPrx: RunPrx = async () => ({ ok: true, stdout: '{"conclusion":"failure"}', stderr: "" });
    const { passed, attestation } = await buildRealCiGate({ runPrx, signer })({ workUnitId: "GH-2" });
    expect(passed).toBe(false);
    expect(attestation.predicate).toBe("ci.failed");
  });

  test("pending polls until settled — the hard block", async () => {
    const { signer } = newSigner();
    let n = 0;
    const runPrx: RunPrx = async () => ({
      ok: true,
      stdout: n++ < 2 ? '{"conclusion":"pending"}' : '{"conclusion":"success"}',
      stderr: "",
    });
    const { passed } = await buildRealCiGate({ runPrx, signer, sleep: noSleep })({ workUnitId: "GH-3" });
    expect(passed).toBe(true);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  test("a gate that never settles throws (machine retreats, bounded)", async () => {
    const { signer } = newSigner();
    const runPrx: RunPrx = async () => ({ ok: true, stdout: '{"conclusion":"pending"}', stderr: "" });
    let threw = "";
    try {
      await buildRealCiGate({ runPrx, signer, maxPolls: 3, sleep: noSleep })({ workUnitId: "GH-4" });
    } catch (e) {
      threw = String(e);
    }
    expect(threw).toContain("did not settle");
  });

  test("merge runs `publisher merge` + signs merged@pr; failure throws", async () => {
    const { signer } = newSigner();
    const okPrx: RunPrx = async () => ({ ok: true, stdout: "merged PR #9", stderr: "" });
    const { attestation } = await buildRealMerge({ runPrx: okPrx, signer })({ workUnitId: "GH-5" });
    expect(attestation.stage).toBe("merge");
    expect(attestation.predicate).toBe("pr.merged");

    const badPrx: RunPrx = async () => ({ ok: false, stdout: "", stderr: "protected branch" });
    let threw = "";
    try {
      await buildRealMerge({ runPrx: badPrx, signer })({ workUnitId: "GH-6" });
    } catch (e) {
      threw = String(e);
    }
    expect(threw).toContain("publisher merge failed");
  });

  test("buildRealPilotDeps drives the WHOLE real tail to merged with real sigs", async () => {
    const { kp, signer } = newSigner();
    const fakeOpen: OpenSessionFn = async ({ workUnitId }) =>
      ({ status: "opened", worktree_path: `/wt/${workUnitId}`, profile: {} }) as unknown as Awaited<
        ReturnType<OpenSessionFn>
      >;
    const okRun = (): NonInteractiveAgentResult => ({
      kind: "success",
      text: "ok",
      stdout: "ok",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      elapsed_ms: 1,
    });
    const fakeRun: RunAgentFn = async () => okRun();
    const runPrx: RunPrx = async (args) =>
      args[0] === "scout"
        ? { ok: true, stdout: '{"conclusion":"success"}', stderr: "" }
        : { ok: true, stdout: "merged", stderr: "" };

    const deps = buildRealPilotDeps({ openSession: fakeOpen, runAgent: fakeRun, runPrx, signer });
    const actor = createActor(createPilotMachine(deps), { input: { workUnitId: "GH-7" } }).start();
    const done = await waitFor(actor, (s) => s.status === "done", { timeout: 4000 });

    expect(done.value).toBe("merged");
    const ci = done.context.chain.find((l) => l.stage === "ci")!;
    const merge = done.context.chain.find((l) => l.stage === "merge")!;
    expect(ci.signedBy).toBe(kp.keyid);
    expect(merge.signedBy).toBe(kp.keyid);
    expect(ci.predicate).toBe("ci.passed");
    expect(done.context.summary!.signedBy).toBe(kp.keyid);
  });

  test("buildRealPilotDeps refuses without a signing key (no agent unsigned)", () => {
    expect(() => buildRealPilotDeps({ signer: null })).toThrow("must hold a signing key");
  });
});
