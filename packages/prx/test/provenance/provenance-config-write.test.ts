// Fills the injectable-but-untested branches of provenance/config.ts:
// provenanceConfigPath, the resolveProvenanceMaster read-failure fall-through,
// and writeProvenanceTrustMap's merge/malformed/absent paths. All seams are
// injected; the one dev-master fall-through is kept hermetic via XDG_STATE_HOME.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROVENANCE_MASTER_FILE_ENV,
  provenanceConfigPath,
  resolveProvenanceMaster,
  writeProvenanceTrustMap,
} from "../../src/provenance/config.ts";

const tmp = mkdtempSync(join(tmpdir(), "prx-prov-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const envOf = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

describe("provenanceConfigPath", () => {
  test("joins HOME with ~/.config/prx/config.json", () => {
    expect(provenanceConfigPath(envOf({ HOME: "/h" }))).toBe("/h/.config/prx/config.json");
  });
});

describe("resolveProvenanceMaster", () => {
  test("reads the configured master file as base64", () => {
    const master = Buffer.alloc(32, 7).toString("base64");
    const m = resolveProvenanceMaster(
      envOf({ [PROVENANCE_MASTER_FILE_ENV]: "/secret/master" }),
      () => master,
      () => true,
    );
    expect(m).toEqual(Buffer.from(master, "base64"));
  });

  test("falls through to the dev master when the secret file read throws", () => {
    const m = resolveProvenanceMaster(
      // XDG_STATE_HOME points the dev-master fallback at a temp dir.
      envOf({ [PROVENANCE_MASTER_FILE_ENV]: "/secret/master", XDG_STATE_HOME: tmp }),
      () => {
        throw new Error("unreadable secret");
      },
      () => true,
    );
    expect(Buffer.isBuffer(m)).toBe(true);
    expect(m.length).toBeGreaterThan(0);
  });
});

describe("writeProvenanceTrustMap", () => {
  test("writes a fresh config when none exists", () => {
    let written: { path: string; data: string } | null = null;
    const path = writeProvenanceTrustMap(
      { alice: "ed25519:AAA" },
      envOf({ HOME: "/h" }),
      () => "",
      () => false, // config does not exist
      (p, d) => {
        written = { path: p, data: d };
      },
    );
    expect(path).toBe("/h/.config/prx/config.json");
    expect(written!.path).toBe("/h/.config/prx/config.json");
    expect(JSON.parse(written!.data).provenance.trust).toEqual({ alice: "ed25519:AAA" });
  });

  test("merges into an existing provenance block, preserving masterFile", () => {
    let data = "";
    writeProvenanceTrustMap(
      { bob: "ed25519:BBB" },
      envOf({ HOME: "/h" }),
      () => JSON.stringify({ provenance: { masterFile: "/m", trust: { old: "x" } }, other: 1 }),
      () => true,
      (_p, d) => {
        data = d;
      },
    );
    const parsed = JSON.parse(data);
    expect(parsed.provenance.masterFile).toBe("/m");
    expect(parsed.provenance.trust).toEqual({ bob: "ed25519:BBB" });
    expect(parsed.other).toBe(1);
  });

  test("treats a malformed existing config as empty", () => {
    let data = "";
    writeProvenanceTrustMap(
      { c: "ed25519:CCC" },
      envOf({ HOME: "/h" }),
      () => "{ not json",
      () => true,
      (_p, d) => {
        data = d;
      },
    );
    expect(JSON.parse(data).provenance.trust).toEqual({ c: "ed25519:CCC" });
  });

  test("the default read/exists/write persist to a real config file", () => {
    // No injected seams → exercises the production mkdirSync + writeFileSync
    // default (and the real existsSync/readFileSync) against a temp HOME.
    const home = mkdtempSync(join(tmpdir(), "prx-home-"));
    try {
      const p = writeProvenanceTrustMap({ e: "ed25519:EEE" }, envOf({ HOME: home }));
      expect(JSON.parse(readFileSync(p, "utf8")).provenance.trust).toEqual({ e: "ed25519:EEE" });
      // A second write re-reads the now-existing file and merges.
      writeProvenanceTrustMap({ f: "ed25519:FFF" }, envOf({ HOME: home }));
      expect(JSON.parse(readFileSync(p, "utf8")).provenance.trust).toEqual({ f: "ed25519:FFF" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("treats a non-object provenance field as empty", () => {
    let data = "";
    writeProvenanceTrustMap(
      { d: "ed25519:DDD" },
      envOf({ HOME: "/h" }),
      () => JSON.stringify({ provenance: "oops" }),
      () => true,
      (_p, d) => {
        data = d;
      },
    );
    expect(JSON.parse(data).provenance.trust).toEqual({ d: "ed25519:DDD" });
  });
});
