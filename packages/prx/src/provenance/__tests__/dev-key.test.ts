// GH-2282: persisted dev provenance identity. Env (XDG_STATE_HOME) is injected
// so these tests never touch the operator's real state dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dssePae,
  DSSE_PAYLOAD_TYPE,
  ed25519Signer,
  ed25519Verifier,
} from "@bounded-systems/anchored-chain";

import {
  DEV_KEY_DIR,
  DEV_KEY_FILE,
  DevKeyError,
  loadOrCreateDevKeypair,
  resolveDevKeyPath,
  resolveDevKeyPathForDisplay,
} from "../dev-key.ts";

let stateHome: string;
function env(extra: Record<string, string | undefined> = {}) {
  return (key: string) => ({ XDG_STATE_HOME: stateHome, ...extra })[key];
}

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), "prx-devkey-"));
});
afterEach(() => {
  rmSync(stateHome, { recursive: true, force: true });
});

describe("resolveDevKeyPath", () => {
  test("XDG_STATE_HOME → <state>/prx/provenance/dev-ed25519.json", () => {
    const { path, source } = resolveDevKeyPathForDisplay(env());
    expect(path).toBe(join(stateHome, "prx", DEV_KEY_DIR, DEV_KEY_FILE));
    expect(source).toBe("XDG_STATE_HOME");
  });

  test("falls back to $HOME/.local/state when XDG_STATE_HOME unset", () => {
    const { path, source } = resolveDevKeyPathForDisplay((k) => ({ HOME: "/home/x" })[k]);
    expect(path).toBe(join("/home/x", ".local", "state", "prx", DEV_KEY_DIR, DEV_KEY_FILE));
    expect(source).toBe("XDG_STATE_HOME (default)");
  });

  test("throws when neither XDG_STATE_HOME nor HOME is set", () => {
    expect(() => resolveDevKeyPath((_k) => undefined)).toThrow(DevKeyError);
  });
});

describe("loadOrCreateDevKeypair", () => {
  test("generates + persists on first use, then reuses the same identity", () => {
    const path = resolveDevKeyPath(env());
    const a = loadOrCreateDevKeypair(env());
    const fileText = readFileSync(path, "utf8");
    const b = loadOrCreateDevKeypair(env());
    // Second call reuses the persisted file (no rewrite, same keyid).
    expect(b.keyid).toBe(a.keyid);
    expect(b.point).toBe(a.point);
    expect(readFileSync(path, "utf8")).toBe(fileText);
  });

  test("persists with 0o600 perms", () => {
    const path = resolveDevKeyPath(env());
    loadOrCreateDevKeypair(env());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("on-disk seed/point round-trip through a working sign→verify pair", async () => {
    const kp = loadOrCreateDevKeypair(env());
    // Rebuild signer/verifier from the adopted material and check they agree —
    // proving the base64 seed/point survived persistence + re-import.
    const signer = ed25519Signer(kp.privateKey, kp.keyid);
    const verifier = ed25519Verifier(kp.publicKey);
    const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode("x"));
    expect(await verifier.verify(pae, await signer.sign(pae))).toBe(true);
  });

  test("the persisted file carries the documented shape", () => {
    const path = resolveDevKeyPath(env());
    loadOrCreateDevKeypair(env());
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(typeof file.seed).toBe("string");
    expect(typeof file.point).toBe("string");
    expect(typeof file.keyid).toBe("string");
    expect(typeof file.createdAt).toBe("string");
  });

  test("a malformed file is a HARD ERROR, never a silent regenerate", () => {
    const path = resolveDevKeyPath(env());
    // First create a valid file, then corrupt it in place.
    loadOrCreateDevKeypair(env());
    writeFileSync(path, "{ not json", "utf8");
    expect(() => loadOrCreateDevKeypair(env())).toThrow(DevKeyError);
  });

  test("a structurally-invalid (but JSON) file is rejected", () => {
    const path = resolveDevKeyPath(env());
    loadOrCreateDevKeypair(env());
    writeFileSync(path, JSON.stringify({ seed: "abc" }), "utf8");
    expect(() => loadOrCreateDevKeypair(env())).toThrow(DevKeyError);
  });
});
