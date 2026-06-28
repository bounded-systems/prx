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
    # prx-q9yj: tag prx-routed claude sessions as a distinct git-ai agent. Set in
    # THIS wrapper only (never ~/.git-ai/config.json — global would tag every
    # session as prx, destroying the prx-routed-vs-bypass distinction).
    #
    # SCOPE (verified, git-ai 1.6.3): GIT_AI_CUSTOM_ATTRIBUTES is consumed ONLY by
    # git-ai's cloud upload path (GIT_AI_API_KEY → dashboard). It is NOT written to
    # the local authorship note: the note schema (`authorship/3.0.0`) has no
    # `custom_attributes` field — only `sessions.<id>.agent_id.{tool,id,model}`. So
    # `git-ai log/usage/show` (local) never surface `agent=prx`, and a local jq over
    # `custom_attributes` returns nothing. This export is therefore INERT without
    # git-ai cloud — harmless, and the on-ramp for a future cloud-backed adoption
    # metric. A *local* prx-vs-bypass metric needs a different instrument (prx's own
    # telemetry, or git-ai surfacing custom_attributes / a custom tool label).
    ++ lib.optional cfg.gitAiAgent.enable (
      "export GIT_AI_CUSTOM_ATTRIBUTES=" + lib.escapeShellArg (builtins.toJSON (
        {
          agent = "prx";
          version = cfg.gitAiAgent.version;
          door = cfg.gitAiAgent.door;
        } // cfg.gitAiAgent.extraAttributes
      ))
    )
    # GitHub App token broker: when enabled, prx mints a short-lived installation
    # token at startup and publishes it as GH_TOKEN (separate higher rate-limit
    # pool, bot identity, headless — no `gh auth login`). Fail-open to personal
    # `gh` when unset. Only the PATH/ids are emitted here — NEVER the PEM, which
    # must not enter the nix store; the inline-PEM env var (PRX_GH_APP_PRIVATE_KEY)
    # is the cloud-agent-only injection path. Mirrors the provenance.masterFile
    # agenix pattern.
    ++ lib.optionals cfg.githubApp.enable (
      lib.optional (cfg.githubApp.clientId != null)
        ''export PRX_GH_APP_ID="${cfg.githubApp.clientId}"''
      ++ lib.optional (cfg.githubApp.privateKeyFile != null)
        ''export PRX_GH_APP_KEY_FILE="${cfg.githubApp.privateKeyFile}"''
      ++ [ ''export PRX_GH_INSTALLATION_ID="${cfg.githubApp.installationId}"'' ]
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

    # prx-q9yj: tag prx-routed sessions for git-ai attribution. Enabling this
    # makes the wrapper export GIT_AI_CUSTOM_ATTRIBUTES so commits authored via
    # `prx claude` carry `agent=prx` in their git-ai authorship note, while raw
    # `claude` (a prx bypass) stays untagged — making prx adoption measurable.
    gitAiAgent = {
      enable = lib.mkEnableOption ''
        tagging prx-routed claude sessions as a git-ai agent via
        GIT_AI_CUSTOM_ATTRIBUTES (honored by git-ai >= 1.6.3)'';

      door = lib.mkOption {
        type = lib.types.str;
        default = "local";
        example = "vm";
        description = ''
          The `door` recorded in the attributes — the prx launch path this
          wrapper drives (e.g. "local" for the tmux path). Crossing the --vm /
          session-host seam with the var intact is tracked separately (prx-69j /
          prx-bst); this option tags the local path.
        '';
      };

      version = lib.mkOption {
        type = lib.types.str;
        default = bins.version;
        defaultText = lib.literalExpression "the released prx version";
        description = "The `version` recorded in the attributes (defaults to the installed prx).";
      };

      extraAttributes = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        example = lib.literalExpression ''{ host = "macbook"; }'';
        description = "Extra string attributes merged into GIT_AI_CUSTOM_ATTRIBUTES (override agent/version/door if keyed the same).";
      };
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

    githubApp = {
      enable = lib.mkEnableOption ''
        the GitHub App token broker — mint a short-lived installation token at
        startup and publish it as GH_TOKEN (separate higher rate-limit pool, bot
        identity, headless). Fail-open to personal `gh` auth when unconfigured'';

      clientId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "Iv23liAbc123";
        description = ''
          Sets PRX_GH_APP_ID — the App ID or the app's Client ID (GitHub honors
          either as the JWT issuer). Null ⇒ the broker is inert (personal `gh`).
        '';
      };

      privateKeyFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "/run/agenix/prx-gh-app-key";
        description = ''
          Sets PRX_GH_APP_KEY_FILE — path to the agenix/sops-decrypted App
          private-key PEM (mode 0600). The key never enters config or the nix
          store (env carries only the path), mirroring PRX_PROVENANCE_MASTER_FILE.
          For Claude Code cloud agents, inject the PEM directly as the
          PRX_GH_APP_PRIVATE_KEY env secret instead — never emitted by nix.
        '';
      };

      installationId = lib.mkOption {
        type = lib.types.str;
        default = "138039680";
        description = "Sets PRX_GH_INSTALLATION_ID — the installation to mint for (default = the bounded-systems org).";
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
