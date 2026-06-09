# Portable home-manager module for prx. Consume from any home-manager config:
#
#   inputs.prx.url = "github:bounded-systems/prx";
#   # ... in your home-manager modules list:
#   modules = [ prx.homeManagerModules.default ];
#   # ... then:
#   programs.prx = {
#     enable = true;
#     operatorConfigRoot = "${config.home.homeDirectory}/.config/prx-overlays"; # optional
#   };
#
# Installs the released binary (hermetic fetchurl, no sandbox tweak) and wraps it
# to inject the consumer-specific env the released binary does not bake.
self:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.prx;
  bins = import ./fetch-release.nix self { inherit pkgs; };
  zshBin = "${pkgs.zsh}/bin/zsh";

  exports = lib.concatStringsSep "\n" (
    lib.optional (cfg.operatorConfigRoot != null) ''export PRX_OPERATOR_CONFIG_ROOT="${cfg.operatorConfigRoot}"''
    ++ lib.optional (cfg.claudePath != null) ''export BAKED_CLAUDE_CODE_PATH="${cfg.claudePath}"''
    # GH-352: provenance signing. prx deployed in a dev environment IS production
    # for prx, so signing is the identity layer, not a dev convenience. Per-actor
    # keys derive from the master resolved at PRX_PROVENANCE_MASTER_FILE (an
    # agenix/sops-decrypted secret); `PRX_PROVENANCE_KEY=dev` selects per-actor
    # mode; enforcement is fail-closed.
    ++ lib.optionals cfg.provenance.enable (
      lib.optional (cfg.provenance.masterFile != null)
        ''export PRX_PROVENANCE_MASTER_FILE="${cfg.provenance.masterFile}"''
      ++ [ ''export PRX_PROVENANCE_KEY="dev"'' ]
      ++ lib.optional cfg.provenance.requireSigned
        ''export PRX_REQUIRE_SIGNED_DERIVATIONS="1"''
    )
  );

  # The prx launcher: inject the consumer env, then exec the binary.
  wrapper = ''
    #!${zshBin}
    set -euo pipefail
    ${exports}
    exec ${cfg.package}/bin/prx "$@"
  '';

  # `slack-scout` — an installed CLI command for the read-only Slack surface.
  # Same injected env as the prx launcher; delegates to `prx scout slack` so it
  # reuses the prx binary (the verb already lives there — "still in prx"). The
  # self-contained dist/slack-scout binary is a separate artifact for slackd /
  # extraction (prx-hkm / prx-tgy); this is the zero-new-release install path.
  slackScoutWrapper = ''
    #!${zshBin}
    set -euo pipefail
    ${exports}
    exec ${cfg.package}/bin/prx scout slack "$@"
  '';
in
{
  options.programs.prx = {
    enable = lib.mkEnableOption "prx — the agent-run PR contract / work-unit CLI";

    package = lib.mkOption {
      type = lib.types.package;
      default = bins.prx;
      defaultText = lib.literalExpression "the released prx binary for the host system";
      description = "The prx package to install (defaults to the released binary for this system).";
    };

    operatorConfigRoot = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/you/.config/prx-overlays";
      description = ''
        Sets PRX_OPERATOR_CONFIG_ROOT — the root holding per-repo overlay config at
        <root>/.prx/repos/<reverse-dns>/prx.toml. Leave null if you don't use overlays.
        (Renamed from `aiHomeRoot` / PRX_AI_HOME_ROOT in GH-411.)
      '';
    };

    claudePath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/you/.local/bin/claude";
      description = "Sets BAKED_CLAUDE_CODE_PATH — the claude binary prx shells out to.";
    };

    installSlackScout = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Also install the `slack-scout` command (delegates to `prx scout slack`).";
    };

    provenance = {
      enable = lib.mkEnableOption "prx provenance signing (per-actor, master-derived, enforced)";

      masterFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "/run/agenix/prx-provenance-master";
        description = ''
          Sets PRX_PROVENANCE_MASTER_FILE — the path to the agenix/sops-decrypted
          base64 master secret (a 32-byte key, mode 0600). Per-actor signing keys
          derive from it; the master never enters config or the nix store (the env
          carries only the path). Null ⇒ the zero-config persisted dev master
          (bootstrap; still signs, self-derived). Run `prx keymaker register` once
          after setting this to publish the per-actor public trust map.
        '';
      };

      requireSigned = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Sets PRX_REQUIRE_SIGNED_DERIVATIONS=1 — fail-closed verification: an
          unsigned or untrusted derivation is rejected at the merge-guard /
          publisher tier. The production posture; disable only to debug.
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.file.".local/bin/prx" = { text = wrapper; executable = true; };

    home.file.".local/bin/slack-scout" = lib.mkIf cfg.installSlackScout {
      text = slackScoutWrapper;
      executable = true;
    };
  };
}
