import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { limaDriver, renderLima } from "../../src/executor/lima.ts";
import type { ExecutorSpec } from "../../src/executor/spec.ts";

/** A keeperd-shaped spec, mirroring lima-devshell's intent but Lima 2.0-correct. */
const KEEPERD_SPEC: ExecutorSpec = {
  name: "keeperd-test",
  arch: "aarch64",
  images: [
    {
      location:
        "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img",
      arch: "aarch64",
    },
  ],
  cpus: 4,
  memoryGiB: 6,
  diskGiB: 80,
  mounts: [],
  ssh: { localPort: 0, loadDotSSHPubKeys: true, forwardAgent: true },
  env: { LIMA_WORKDIR_DISABLED: "1" },
  provision: [
    {
      mode: "system",
      script:
        "#!/bin/sh\nif ! id dev >/dev/null 2>&1; then\n  useradd -m -s /bin/bash dev\n  passwd -d dev\n  usermod -aG sudo dev\nfi\n",
    },
  ],
  rosetta: { enabled: true, binfmt: true },
  mountType: "virtiofs",
  mountInotify: true,
};

describe("renderLima — Lima 2.0 correctness", () => {
  const yaml = renderLima(KEEPERD_SPEC);

  test("emits a vz VM with the resource fields", () => {
    expect(yaml).toContain("vmType: vz");
    expect(yaml).toContain("arch: aarch64");
    expect(yaml).toContain("cpus: 4");
    expect(yaml).toContain('memory: "6GiB"');
    expect(yaml).toContain('disk: "80GiB"');
  });

  test("rosetta lives under vmOpts.vz, NOT as the deprecated top-level key", () => {
    expect(yaml).toMatch(/vmOpts:\n {2}vz:\n {4}rosetta:\n {6}enabled: true\n {6}binfmt: true/);
    // No top-level `rosetta:` (column 0) — that's the deprecated form.
    expect(yaml).not.toMatch(/^rosetta:/m);
  });

  test("omits the Lima-2.0-unknown top-level guestAgent field", () => {
    expect(yaml).not.toMatch(/^guestAgent:/m);
  });

  test("renders the provision script as a block scalar", () => {
    expect(yaml).toContain("provision:\n  - mode: system\n    script: |\n      #!/bin/sh");
    expect(yaml).toContain("      if ! id dev >/dev/null 2>&1; then");
  });

  test("quotes env values so '1' stays a string, and empty mounts render as []", () => {
    expect(yaml).toContain('LIMA_WORKDIR_DISABLED: "1"');
    expect(yaml).toContain("mounts: []");
  });

  test("validates the spec at the seam — a malformed spec throws", () => {
    expect(() => renderLima({ ...KEEPERD_SPEC, name: "" })).toThrow();
    expect(() => renderLima({ ...KEEPERD_SPEC, cpus: -1 })).toThrow();
  });
});

describe("limaDriver", () => {
  test("is the lima driver and renders identically to renderLima", () => {
    expect(limaDriver.id).toBe("lima");
    expect(limaDriver.render(KEEPERD_SPEC)).toBe(renderLima(KEEPERD_SPEC));
  });
});

// Oracle: the rendered config must pass `limactl validate` with ZERO warnings
// (no "unknown field", no "deprecated"). Skipped where limactl is absent (CI).
const hasLimactl = Bun.which("limactl") !== null;
describe("renderLima — limactl validate oracle", () => {
  (hasLimactl ? test : test.skip)("rendered config validates with no warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-lima-"));
    const file = join(dir, "lima.yaml");
    try {
      writeFileSync(file, renderLima(KEEPERD_SPEC));
      const res = spawnSync("limactl", ["validate", file], { encoding: "utf8" });
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      expect(res.status).toBe(0);
      expect(out).toContain("OK");
      expect(out).not.toContain("level=warning");
      expect(out).not.toContain("unknown field");
      expect(out).not.toContain("deprecated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
