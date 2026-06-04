# Portable home-manager module for prx. Consume from any home-manager config:
#
#   inputs.prx.url = "github:bounded-systems/prx";
#   # ... in your home-manager modules list:
#   modules = [ prx.homeManagerModules.default ];
#   # ... then:
#   programs.prx = {
#     enable = true;
#     aiHomeRoot = "${config.home.homeDirectory}/.config/ai-home"; # optional
#     installWt  = true;   # optional `wt` worktree wrapper
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
    lib.optional (cfg.aiHomeRoot != null) ''export PRX_AI_HOME_ROOT="${cfg.aiHomeRoot}"''
    ++ lib.optional (cfg.claudePath != null) ''export BAKED_CLAUDE_CODE_PATH="${cfg.claudePath}"''
  );

  # subcmd is "" for prx, "repos " for repox (the trailing space matters).
  wrapper = subcmd: ''
    #!${zshBin}
    set -euo pipefail
    ${exports}
    exec ${cfg.package}/bin/prx ${subcmd}"$@"
  '';

  wtWrapper = pkgs.writeShellScriptBin "wt"
    (builtins.readFile (self + "/packages/prx/scripts/wt-wrapper.sh"));
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

    aiHomeRoot = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/you/.config/ai-home";
      description = ''
        Sets PRX_AI_HOME_ROOT — the root holding per-repo overlay config at
        <root>/.prx/repos/<reverse-dns>/prx.toml. Leave null if you don't use overlays.
      '';
    };

    claudePath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/you/.local/bin/claude";
      description = "Sets BAKED_CLAUDE_CODE_PATH — the claude binary prx shells out to.";
    };

    installWt = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Also install the `wt` worktree wrapper (delegates to `prx tools wt exec`).";
    };
  };

  config = lib.mkIf cfg.enable {
    home.file.".local/bin/prx" = { text = wrapper ""; executable = true; };
    home.file.".local/bin/repox" = { text = wrapper "repos "; executable = true; };

    home.file.".local/bin/wt" = lib.mkIf cfg.installWt {
      source = "${wtWrapper}/bin/wt";
      executable = true;
    };
  };
}
