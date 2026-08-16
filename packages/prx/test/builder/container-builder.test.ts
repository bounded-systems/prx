import { describe, expect, test } from "bun:test";

import {
  BUILDER_CONTAINER_NAME,
  BUILDER_SSH_ALIAS,
  builderStateDir,
  builderKeyPath,
  renderBuilderRunArgs,
  renderBuilderMachineLine,
  renderBuilderSshConfig,
} from "../../src/builder/container-builder.ts";
import {
  NIX_BUILDER_IMAGE,
  NIX_BUILDER_SSH_PORT,
  NIX_BUILDER_STORE_VOLUME,
  NIX_BUILDER_AUTHKEYS_PATH,
} from "../../src/room/nix-builder-service.ts";

const fakeEnv = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

describe("builderStateDir / builderKeyPath", () => {
  test("prefers XDG_STATE_HOME", () => {
    const env = fakeEnv({ XDG_STATE_HOME: "/xdg/state", HOME: "/home/u" });
    expect(builderStateDir(env)).toBe("/xdg/state/prx/builder");
    expect(builderKeyPath(env)).toBe("/xdg/state/prx/builder/id_ed25519");
  });
  test("falls back to ~/.local/state", () => {
    expect(builderStateDir(fakeEnv({ HOME: "/home/u" }))).toBe("/home/u/.local/state/prx/builder");
  });
});

describe("renderBuilderRunArgs", () => {
  const args = renderBuilderRunArgs({ pubKeyPath: "/k/id.pub" });
  test("is a detached, replace, restart-always podman run of the pinned image", () => {
    expect(args.slice(0, 5)).toEqual(["run", "-d", "--replace", "--restart", "always"]);
    expect(args).toContain(BUILDER_CONTAINER_NAME);
    expect(args.at(-1)).toBe(NIX_BUILDER_IMAGE);
  });
  test("publishes the ssh port, mounts the /nix volume + the pubkey authorized_keys", () => {
    expect(args).toContain(`${NIX_BUILDER_SSH_PORT}:22`);
    expect(args).toContain(`${NIX_BUILDER_STORE_VOLUME}:/nix`);
    expect(args).toContain(`/k/id.pub:${NIX_BUILDER_AUTHKEYS_PATH}:ro`);
  });
  test("honors overrides", () => {
    const a = renderBuilderRunArgs({
      pubKeyPath: "/k.pub",
      name: "b",
      port: 9999,
      storeVolume: "v",
      image: "img",
    });
    expect(a).toContain("b");
    expect(a).toContain("9999:22");
    expect(a).toContain("v:/nix");
    expect(a.at(-1)).toBe("img");
  });
});

describe("renderBuilderMachineLine", () => {
  test("renders the 8 /etc/nix/machines fields with the container alias + key", () => {
    const line = renderBuilderMachineLine({ keyPath: "/k/id_ed25519" });
    const f = line.split(" ");
    expect(f).toHaveLength(8);
    expect(f[0]).toBe(`ssh-ng://root@${BUILDER_SSH_ALIAS}`);
    expect(f[1]).toBe("aarch64-linux");
    expect(f[2]).toBe("/k/id_ed25519");
    expect(f[3]).toBe("4"); // maxJobs default
    expect(f[5]).toBe("big-parallel");
  });
  test("honors maxJobs / systems overrides", () => {
    const line = renderBuilderMachineLine({
      keyPath: "/k",
      maxJobs: 8,
      systems: "aarch64-linux,x86_64-linux",
    });
    const f = line.split(" ");
    expect(f[1]).toBe("aarch64-linux,x86_64-linux");
    expect(f[3]).toBe("8");
  });
});

describe("renderBuilderSshConfig", () => {
  const cfg = renderBuilderSshConfig({ keyPath: "/k/id_ed25519" });
  test("maps the alias to localhost:port with the key", () => {
    expect(cfg).toContain(`Host ${BUILDER_SSH_ALIAS}`);
    expect(cfg).toContain("HostName 127.0.0.1");
    expect(cfg).toContain(`Port ${NIX_BUILDER_SSH_PORT}`);
    expect(cfg).toContain("User root");
    expect(cfg).toContain("IdentityFile /k/id_ed25519");
    expect(cfg).toContain("IdentitiesOnly yes");
  });
});
