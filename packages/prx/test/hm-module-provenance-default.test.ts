import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const hmModule = readFileSync(resolve(repoRoot, "nix/hm-module.nix"), "utf8");

/**
 * #433: the signer must reach a deployment WITH the binary that enforces it.
 *
 * `ciSigningDecision` is fail-closed — a provenance ledger in scope plus no
 * signer is `fail` (exit 65), not `skip` (#396 for `prx ci`, #427 for an
 * in-pipeline `scout read`). The home-manager module and the released binary
 * ship from this same flake, so a consumer picking up the signing release also
 * picks up this module: `programs.prx.provenance.enable` defaulting ON is what
 * makes that update a no-op for them instead of a breakage. Defaulted off, the
 * wrapper exports no `PRX_PROVENANCE_KEY`, the posture is `unconfigured`, and
 * the decision is `fail`.
 *
 * A regression here is silent — nothing in this repo's suite executes the
 * deployed wrapper, and the symptom only appears on someone else's machine
 * after `home-manager switch`. So the default is pinned here as text.
 *
 * Implemented as a bun test rather than a nix flake check for the reason
 * `no-operational-python.test.ts` already records: flake.nix exposes only
 * `homeManagerModules` — there is no checks/nixpkgs infrastructure — and this
 * runs in the existing `prx ci` / `bun test` phase.
 *
 * Comments are stripped before parsing: prose in this very file quotes
 * `masterFile = null`, and an earlier draft of this test anchored on that quote
 * instead of the option, which made it pass against a reverted default.
 */
const source = hmModule.replace(/^[ \t]*#.*$/gm, "");

describe("hm-module: provenance signing is on by default (#433)", () => {
  /** The `provenance` option block, comment-free, brace-matched from its `{`. */
  function provenanceBlock(): string {
    const at = source.indexOf("provenance = {");
    expect(at, "nix/hm-module.nix must declare a `provenance` option block").toBeGreaterThan(-1);
    const open = source.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
    }
    throw new Error("unbalanced braces in the `provenance` option block");
  }

  /** Just `enable`'s declaration — up to the next sibling option's assignment. */
  function enableDecl(): string {
    const block = provenanceBlock();
    const at = block.indexOf("enable =");
    expect(at, "the provenance block must declare `enable`").toBeGreaterThan(-1);
    const rest = block.slice(at);
    const sibling = /\n\s{6}[A-Za-z][A-Za-z0-9]*\s*=/.exec(rest);
    return sibling ? rest.slice(0, sibling.index) : rest;
  }

  test("`provenance.enable` defaults to true", () => {
    expect(enableDecl()).toMatch(/\bdefault\s*=\s*true\s*;/);
  });

  test("`provenance.enable` is not an mkEnableOption (which would default it off)", () => {
    expect(
      enableDecl(),
      "mkEnableOption defaults to false — #433 requires the signer to ship enabled",
    ).not.toContain("mkEnableOption");
  });

  test("enabling provenance exports the zero-config dev signer", () => {
    // The bootstrap posture is what keeps a signer-less deployment signing
    // rather than failing: `dev` + a null masterFile resolves the persisted dev
    // master (`resolveProvenanceMaster` → `loadOrCreateDevMaster`).
    expect(source).toContain('export PRX_PROVENANCE_KEY="dev"');
  });
});
