import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommitSigningKeyError,
  loadOrCreateCommitSigningKey,
  resolveCommitSigningKeyPath,
} from "../../src/provenance/commit-signing-key.ts";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "prx-sign-"));
  made.push(d);
  return d;
}
const envFrom = (state: string) => (k: string) => (k === "XDG_STATE_HOME" ? state : undefined);

/** Stub keygen — writes placeholder key + pub (no real ssh-keygen). */
const stubKeygen = (path: string) => {
  writeFileSync(path, "PRIVATE\n");
  writeFileSync(`${path}.pub`, "ssh-ed25519 AAAApub prx-keeper-commit-signing\n");
};

describe("commit-signing-key (prx-e7cl)", () => {
  test("path resolves under <XDG_STATE_HOME>/prx/signing — internal to prx", () => {
    expect(resolveCommitSigningKeyPath(envFrom("/x/state"))).toBe(
      "/x/state/prx/signing/id_ed25519",
    );
  });

  test("generate-on-first-use, then reuse the same persisted key", () => {
    const state = stateDir();
    let gens = 0;
    const keygen = (p: string) => {
      gens++;
      stubKeygen(p);
    };
    const a = loadOrCreateCommitSigningKey(envFrom(state), keygen);
    expect(existsSync(a.privateKeyPath)).toBe(true);
    expect(a.publicKey).toContain("ssh-ed25519");
    const b = loadOrCreateCommitSigningKey(envFrom(state), keygen);
    expect(b.privateKeyPath).toBe(a.privateKeyPath);
    expect(gens).toBe(1); // generated once, reused thereafter
  });

  test("no prx state root → hard error (never silently host/cloud)", () => {
    expect(() => loadOrCreateCommitSigningKey(() => undefined, stubKeygen)).toThrow(
      CommitSigningKeyError,
    );
  });

  // Exercises the DEFAULT keygen (real ssh-keygen via the proc seam), proving the
  // internal key is a genuine ed25519 SSH key prx owns end to end.
  test("default keygen mints a real ed25519 SSH key under the prx state dir", () => {
    const state = stateDir();
    const key = loadOrCreateCommitSigningKey(envFrom(state)); // no stub → real ssh-keygen
    expect(existsSync(key.privateKeyPath)).toBe(true);
    expect(key.privateKeyPath).toBe(resolveCommitSigningKeyPath(envFrom(state)));
    expect(key.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
  });
});
