/**
 * Shared in-VM keygen for keeperd actor keys (GH-201 / GH-236).
 *
 * Generates an ed25519 SSH key INSIDE the Lima VM and prints ONLY its public
 * half — the private key is born in the VM and never leaves it (the GH-201/236
 * isolation criterion: "private key provably absent from the host"). Used by both
 * the deploy-key (push credential) and signing-key (provenance + GitHub-verified)
 * bootstraps; the ONLY behavioral difference is whether github.com's host key is
 * pinned (push/deploy keys need it for the first non-interactive push; signing
 * keys don't push). This module never reads or transmits the private key — it
 * only invokes `ssh-keygen` over `limactl shell` and echoes the public key.
 */

import { spawnSync } from "node:child_process";

export interface VmKeygenConfig {
  /** Human label for messages/help, e.g. `deploy key` / `signing key`. */
  kind: string;
  /** Default key path relative to the VM user's `$HOME`. */
  defaultKeyRel: string;
  /** Default key comment. */
  defaultComment: string;
  /** Pin github.com into known_hosts (push/deploy keys; signing keys don't push). */
  pinGithubHostKey: boolean;
  /** One-line "register the printed pubkey like this" hint for `--help`. */
  registerHint: string;
  /** Script path shown in usage, e.g. `scripts/keeperd/setup-vm-signing-key.ts`. */
  scriptPath: string;
}

interface Options {
  vm: string;
  keyRel: string;
  comment: string;
  force: boolean;
}

const DEFAULT_VM = "bdelanghe-lima-devshell-main";

/**
 * The body that runs IN the VM. Positional params: $1=key-rel $2=comment
 * $3=force $4=pin-host-key. Fed to `sh -s --` over stdin so no host-side shell
 * expansion touches the (in-VM) key path, and no private key material is read out.
 */
const REMOTE_SCRIPT = `set -eu
KEY="$HOME/$1"
COMMENT="$2"
FORCE="$3"
PIN_HOST_KEY="$4"
SSH_DIR="$(dirname "$KEY")"

mkdir -p "$SSH_DIR" && chmod 700 "$SSH_DIR"

if [ -f "$KEY" ] && [ "$FORCE" != "1" ]; then
  echo "key already exists: $KEY (use --force to regenerate)" >&2
  echo "----- PUBLIC KEY (safe to share) -----"
  cat "$KEY.pub"
  exit 0
fi

[ "$FORCE" = "1" ] && rm -f "$KEY" "$KEY.pub"
ssh-keygen -t ed25519 -N "" -C "$COMMENT" -f "$KEY" >/dev/null
chmod 600 "$KEY"

if [ "$PIN_HOST_KEY" = "1" ]; then
  # Pin GitHub's host key once so the first non-interactive push doesn't stall.
  touch "$SSH_DIR/known_hosts"
  if ! ssh-keygen -F github.com -f "$SSH_DIR/known_hosts" >/dev/null 2>&1; then
    ssh-keyscan -t ed25519 github.com >> "$SSH_DIR/known_hosts" 2>/dev/null || true
  fi
fi

echo "----- PUBLIC KEY (safe to share) -----"
cat "$KEY.pub"
`;

function required(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

function printHelp(config: VmKeygenConfig): void {
  console.log(
    [
      `keeperd VM ${config.kind} bootstrap.`,
      "",
      `Generates an ed25519 SSH ${config.kind} INSIDE the Lima VM and prints ONLY its`,
      "public half — the private key is born in the VM and never leaves it.",
      "",
      "Usage:",
      `  bun ${config.scriptPath} [--vm NAME] [--key REL] [--comment C] [--force]`,
      "",
      `  --vm NAME      Lima VM name        (default: ${DEFAULT_VM})`,
      `  --key REL      key path relative to the VM user's $HOME (default: ${config.defaultKeyRel})`,
      `  --comment C    key comment         (default: ${config.defaultComment})`,
      "  --force        regenerate even if a key exists (invalidates the old pubkey)",
      "",
      `Register the printed public key:  ${config.registerHint}`,
    ].join("\n"),
  );
}

function parseArgs(argv: string[], config: VmKeygenConfig): Options {
  const opts: Options = {
    vm: DEFAULT_VM,
    keyRel: config.defaultKeyRel,
    comment: config.defaultComment,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--vm":
        opts.vm = required(argv, ++i, arg);
        break;
      case "--key":
        opts.keyRel = required(argv, ++i, arg);
        break;
      case "--comment":
        opts.comment = required(argv, ++i, arg);
        break;
      case "--force":
        opts.force = true;
        break;
      case "-h":
      case "--help":
        printHelp(config);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- process.exit above is `never`
      default:
        console.error(`unknown arg: ${arg} (try --help)`);
        process.exit(2);
    }
  }
  return opts;
}

/**
 * Parse argv and generate the key in the VM per `config`. Exits the process with
 * the in-VM `ssh-keygen` exit status (or 1 on a spawn failure). `--workdir /`
 * stops limactl trying to cd into the host CWD inside the VM (a benign but
 * confusing "cd: … No such file or directory"); the remote script uses $HOME.
 */
export function runVmKeygenCli(argv: string[], config: VmKeygenConfig): void {
  const opts = parseArgs(argv, config);
  const result = spawnSync(
    "limactl",
    [
      "shell", "--workdir", "/", opts.vm, "--",
      "sh", "-s", "--",
      opts.keyRel, opts.comment, opts.force ? "1" : "0", config.pinGithubHostKey ? "1" : "0",
    ],
    { input: REMOTE_SCRIPT, stdio: ["pipe", "inherit", "inherit"] },
  );
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.error("limactl not found on PATH");
      process.exit(1);
    }
    console.error(`failed to run limactl: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
