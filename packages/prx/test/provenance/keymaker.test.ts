/**
 * prx-keymaker slice 4: the `prx keymaker` registrar verbs.
 *
 * The keymaker is secretless: it derives PUBLIC keys + writes the trust map, and
 * never signs. These tests pin that contract — register publishes every actor's
 * public key and reports what changed; drift reports rotated/unregistered actors;
 * digest is pure. All effects are injected (no real keys, no real config files).
 */
import { describe, expect, test } from "bun:test";

import {
  deriveTrustMap,
  type KeymakerDeps,
  keymakerDigest,
  keymakerDrift,
  keymakerRegister,
} from "../../src/provenance/keymaker.ts";

const master = Buffer.from("deployment-master-secret-32-byte");

describe("keymaker verbs (prx-keymaker slice 4)", () => {
  test("digest is the pure actor@<id> (works for any actor, incl. non-profile)", () => {
    expect(keymakerDigest("implement")).toMatch(/^implement@[0-9a-f]{12}$/);
    expect(keymakerDigest("keeper")).toMatch(/^keeper@[0-9a-f]{12}$/);
  });

  test("register writes the full public trust map (ed25519 pubkeys only)", () => {
    const writes: Record<string, string>[] = [];
    const deps: KeymakerDeps = {
      master: () => master,
      readTrust: () => ({}),
      writeTrust: (t) => {
        writes.push(t);
      },
    };
    const r = keymakerRegister(deps);
    expect(Object.keys(r.trust).length).toBeGreaterThan(0);
    expect(writes[0]).toEqual(r.trust);
    for (const pub of Object.values(r.trust)) expect(pub).toMatch(/^ed25519:/);
    // first registration → everything is "changed"
    expect(r.changed.length).toBe(Object.keys(r.trust).length);
  });

  test("register reports ONLY the actors whose key changed", () => {
    const full = deriveTrustMap(master);
    const stale = { ...full, implement: "ed25519:STALE" };
    const deps: KeymakerDeps = {
      master: () => master,
      readTrust: () => stale,
      writeTrust: () => {},
    };
    expect(keymakerRegister(deps).changed).toEqual(["implement"]);
  });

  test("drift reports rotated + unregistered actors; empty when current", () => {
    const full = deriveTrustMap(master);
    const cfg: Record<string, string> = { ...full, implement: "ed25519:OLD" }; // implement rotated
    delete cfg.plan; // plan never registered
    const deps: KeymakerDeps = {
      master: () => master,
      readTrust: () => cfg,
      writeTrust: () => {},
    };
    const drift = keymakerDrift(deps);
    expect(drift).toContainEqual({ actor: "plan", reason: "unregistered" });
    expect(drift).toContainEqual({ actor: "implement", reason: "rotated" });

    const current: KeymakerDeps = {
      master: () => master,
      readTrust: () => full,
      writeTrust: () => {},
    };
    expect(keymakerDrift(current)).toEqual([]);
  });
});
