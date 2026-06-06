#!/usr/bin/env bun
/**
 * keeperd VM deploy-key bootstrap (GH-201, live slice 3b).
 *
 * Generates an ed25519 SSH deploy key INSIDE the Lima VM and prints ONLY its
 * public half. The private key is born in the VM and never leaves it — it is the
 * in-VM push credential, satisfying the GH-201 isolation criterion ("private key
 * provably absent from the host"). This script never reads or transmits the
 * private key; it only invokes `ssh-keygen` over `limactl shell` and echoes the
 * public key.
 *
 * Idempotent: if the key already exists it prints the existing public key and
 * exits 0 without regenerating, unless `--force` is given (which removes and
 * regenerates — INVALIDATING any deploy key already registered from the old one).
 *
 * Usage:
 *   bun scripts/keeperd/setup-vm-deploy-key.ts [--vm NAME] [--key REL] [--comment C] [--force]
 *
 *   --vm NAME      Lima VM name        (default: bdelanghe-lima-devshell-main)
 *   --key REL      key path relative to the VM user's $HOME
 *                                      (default: .ssh/keeper_deploy)
 *   --comment C    key comment         (default: keeperd@lima-devshell)
 *   --force        regenerate even if a key exists (invalidates the old pubkey)
 *
 * After running, register the printed public key as a *write* deploy key, e.g.:
 *   gh repo deploy-key add <pubfile> \
 *     --repo bounded-systems/keeperd-push-sandbox --allow-write \
 *     --title keeperd-lima-devshell
 */

import { spawnSync } from "node:child_process";

interface Options {
  vm: string;
  keyRel: string;
  comment: string;
  force: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    vm: "bdelanghe-lima-devshell-main",
    keyRel: ".ssh/keeper_deploy",
    comment: "keeperd@lima-devshell",
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
        printHelp();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- process.exit above is `never`
      default:
        console.error(`unknown arg: ${arg} (try --help)`);
        process.exit(2);
    }
  }
  return opts;
}

function required(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

function printHelp(): void {
  // The module docblock is the canonical help text.
  console.log(
    [
      "keeperd VM deploy-key bootstrap (GH-201, live slice 3b).",
      "",
      "Generates an ed25519 SSH deploy key INSIDE the Lima VM and prints ONLY its",
      "public half — the private key is born in the VM and never leaves it.",
      "",
      "Usage:",
      "  bun scripts/keeperd/setup-vm-deploy-key.ts [--vm NAME] [--key REL] [--comment C] [--force]",
      "",
      "  --vm NAME      Lima VM name        (default: bdelanghe-lima-devshell-main)",
      "  --key REL      key path relative to the VM user's $HOME (default: .ssh/keeper_deploy)",
      "  --comment C    key comment         (default: keeperd@lima-devshell)",
      "  --force        regenerate even if a key exists (invalidates the old pubkey)",
    ].join("\n"),
  );
}

/**
 * The body that runs IN the VM. Positional params: $1=key-rel $2=comment
 * $3=force. Fed to `sh -s --` over stdin so no host-side shell expansion touches
 * the (in-VM) key path, and no private key material is ever read out.
 */
const REMOTE_SCRIPT = `set -eu
KEY="$HOME/$1"
COMMENT="$2"
FORCE="$3"
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

# Pin GitHub's host key once so the first non-interactive push doesn't stall.
touch "$SSH_DIR/known_hosts"
if ! ssh-keygen -F github.com -f "$SSH_DIR/known_hosts" >/dev/null 2>&1; then
  ssh-keyscan -t ed25519 github.com >> "$SSH_DIR/known_hosts" 2>/dev/null || true
fi

echo "----- PUBLIC KEY (safe to share) -----"
cat "$KEY.pub"
`;

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  // `--workdir /` stops limactl from trying to cd into the host CWD inside the
  // VM (that path doesn't exist there, which prints a benign but confusing
  // "cd: ... No such file or directory"). The remote script uses $HOME, so the
  // working directory is irrelevant to it.
  const result = spawnSync(
    "limactl",
    ["shell", "--workdir", "/", opts.vm, "--", "sh", "-s", "--", opts.keyRel, opts.comment, opts.force ? "1" : "0"],
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

main();
