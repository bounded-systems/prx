import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const modulePath = join(repoRoot, "nix", "home-manager", "codex.nix");
const readmePath = join(repoRoot, "README.md");
const hmReadmePath = join(repoRoot, "nix", "home-manager", "README.md");
const configPath = join(repoRoot, "codex", "config.toml");
const flakePath = join(repoRoot, "flake.nix");

describe("nix/home-manager/codex.nix", () => {
  test("module file exists", () => {
    expect(existsSync(modulePath)).toBe(true);
  });

  test("manages ~/.codex/config.toml as a Home Manager file", () => {
    const module = readFileSync(modulePath, "utf8");
    expect(module).toContain('home.file.".codex/config.toml".source');
    expect(module).not.toContain("home.activation");
    expect(module).not.toContain("seedWritableConfig");
    expect(module).not.toContain("chmod 600");
    expect(module).not.toContain("cp \"$source_cfg\" \"$target\"");
  });

  test("still gates config deployment on programs.codex.enable", () => {
    const module = readFileSync(modulePath, "utf8");
    expect(module).toContain("cfg = config.programs.codex");
    expect(module).toContain("lib.mkIf cfg.enable");
  });

  test("defaults programs.codex.package to the pinned repo-managed package", () => {
    const module = readFileSync(modulePath, "utf8");
    expect(module).toContain("import ../packages/codex.nix");
    expect(module).toContain("programs.codex.package = lib.mkDefault codexPackage");
  });
});

describe("Codex config ownership docs", () => {
  test("root README documents read-only managed config and pinned package", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("read-only managed file");
    expect(readme).toContain("pins the Codex release version, asset URLs, and hashes in-repo");
    expect(readme).toContain("programs.codex.package");
  });

  test("home-manager README documents declarative config and package override behavior", () => {
    const readme = readFileSync(hmReadmePath, "utf8");
    expect(readme).toContain("read-only Home Manager link");
    expect(readme).toContain("`0.120.0` in `nix/packages/codex.nix`");
    expect(readme).toContain("Callers can still override `programs.codex.package` explicitly");
  });

  test("tracked Codex config stays repo-managed and ChatGPT-compatible", () => {
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("Managed by ai-home / Home Manager");
    expect(config).not.toContain("\nmodel = ");
    expect(config).toContain("[notice.model_migrations]");
  });
});

describe("flake.nix", () => {
  test("codex module wires from ai-home-src self, not a flake input", () => {
    const flake = readFileSync(flakePath, "utf8");
    expect(flake).toContain(
      "import ./nix/home-manager/codex.nix (args // { ai-home-src = self; });",
    );
    expect(flake).not.toContain("codexFlake");
    expect(flake).not.toMatch(/inputs\s*=\s*\{[^}]*codex/);
  });
});

describe("nix/packages/codex.nix", () => {
  test("pins Codex 0.120.0 release assets for supported systems", () => {
    const pkg = readFileSync(join(repoRoot, "nix", "packages", "codex.nix"), "utf8");
    expect(pkg).toContain('version = "0.120.0"');
    expect(pkg).toContain("codex-aarch64-apple-darwin.tar.gz");
    expect(pkg).toContain("codex-x86_64-apple-darwin.tar.gz");
    expect(pkg).toContain("codex-aarch64-unknown-linux-gnu.tar.gz");
    expect(pkg).toContain("codex-x86_64-unknown-linux-gnu.tar.gz");
  });
});
