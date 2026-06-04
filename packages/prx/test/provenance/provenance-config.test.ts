/**
 * prx-keymaker slice 3: the deployment-secret seam + the public trust map.
 *
 * "More deployment, less config": the signing master comes from a deployment
 * secret file (sops/agenix), the env/config carries only its PATH, and the trust
 * map (actor → public key) is the only provenance material that lives in config.
 * All fs/env reads are injected — these tests touch no real files.
 */
import { describe, expect, test } from "bun:test";

import {
  PROVENANCE_MASTER_FILE_ENV,
  readProvenanceTrustMap,
  resolveProvenanceMaster,
} from "../../src/provenance/config.ts";

describe("provenance config — deployment secret + public trust map (prx-keymaker slice 3)", () => {
  test("resolveProvenanceMaster reads the deployment-secret file (env path wins)", () => {
    const secret = Buffer.from("deployment-master-secret-32-byte").toString("base64");
    const env = (k: string) =>
      k === PROVENANCE_MASTER_FILE_ENV ? "/run/secrets/prx-master" : k === "HOME" ? "/home/u" : undefined;
    const read = (p: string) => (p === "/run/secrets/prx-master" ? secret : "{}");
    const exists = (p: string) => p === "/run/secrets/prx-master";
    expect(resolveProvenanceMaster(env, read, exists).toString("base64")).toBe(secret);
  });

  test("config masterFile is used when no env var (path in config, secret on disk)", () => {
    const secret = Buffer.from("cfg-master-secret-thirty-two-byt").toString("base64");
    const config = JSON.stringify({ provenance: { masterFile: "/run/secrets/cfg" } });
    const env = (k: string) => (k === "HOME" ? "/home/u" : undefined);
    const read = (p: string) =>
      p === "/run/secrets/cfg" ? secret : p.endsWith("config.json") ? config : "";
    const exists = (p: string) => p === "/run/secrets/cfg" || p.endsWith("config.json");
    expect(resolveProvenanceMaster(env, read, exists).toString("base64")).toBe(secret);
  });

  test("readProvenanceTrustMap reads provenance.trust (PUBLIC keys, in config)", () => {
    const config = JSON.stringify({
      provenance: { trust: { keeper: "ed25519:AAAA", implement: "ed25519:BBBB" } },
    });
    const env = (k: string) => (k === "HOME" ? "/home/u" : undefined);
    const trust = readProvenanceTrustMap(env, () => config, () => true);
    expect(trust.keeper).toBe("ed25519:AAAA");
    expect(trust.implement).toBe("ed25519:BBBB");
  });

  test("a malformed config is treated as absent — never breaks signing", () => {
    const env = (k: string) => (k === "HOME" ? "/home/u" : undefined);
    expect(readProvenanceTrustMap(env, () => "{ not json", () => true)).toEqual({});
  });

  test("no trust map configured → empty (the dev derive-from-master path applies)", () => {
    const env = (k: string) => (k === "HOME" ? "/home/u" : undefined);
    expect(readProvenanceTrustMap(env, () => "{}", () => false)).toEqual({});
  });
});
