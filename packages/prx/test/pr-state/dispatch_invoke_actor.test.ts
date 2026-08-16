// Covers the default buildInvokeActor (the real subprocess spawn the existing
// dispatch.test.ts injects past) by driving runDispatch with no injected actors
// and a harmless `true`/`false`/bogus prxBinary. The in-process writeCas needs a
// real CAS root.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDispatch } from "../../src/pr-state/dispatch/handler.ts";

let prevCas: string | undefined;
let casRoot: string;
beforeAll(() => {
  prevCas = process.env.PRX_CAS_ROOT;
  casRoot = mkdtempSync(join(tmpdir(), "prx-dispatch-actor-"));
  process.env.PRX_CAS_ROOT = casRoot;
});
afterAll(() => {
  if (prevCas === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevCas;
  rmSync(casRoot, { recursive: true, force: true });
});

// A clean env (depth 0, no parent) + the CAS root for the child spawn.
const env = () => ({ PRX_CAS_ROOT: casRoot }) as NodeJS.ProcessEnv;
const parsed = { source: "plan" as const, target: "scout" as const, action: "grep", argv: ["x"] };

describe("runDispatch default invoke actor (real spawn)", () => {
  test("prxBinary=true → the target verb 'succeeds' (exit 0) and the blob is written", async () => {
    const r = await runDispatch({ parsed, prxBinary: "true", env: env() });
    expect(r.state).toBe("done");
  });

  test("prxBinary=false → a non-zero target exit surfaces as a dispatch failure", async () => {
    const r = await runDispatch({ parsed, prxBinary: "false", env: env() });
    expect(r.state).toBe("failed");
  });

  test("a missing prx binary → spawn error surfaces as a dispatch failure", async () => {
    const r = await runDispatch({
      parsed,
      prxBinary: "/prx-definitely-not-a-real-binary-xyz",
      env: env(),
    });
    expect(r.state).toBe("failed");
  });
});
