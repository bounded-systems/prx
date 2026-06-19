#!/usr/bin/env bun
// slack-setup.ts — provision + prove the slack-scout read token. Secrets live in
// 1Password; this script never writes them to disk or shell history.
//
//   export OP_ACCOUNT=pushd.1password.com OP_VAULT=Employee       # your 1Password target
//   export SLACK_CLIENT_ID=...                                    # not secret
//   read -rs SLACK_CLIENT_SECRET && export SLACK_CLIENT_SECRET    # hidden, in YOUR shell
//   bun run packages/slack/scripts/slack-setup.ts store           # store ID + Secret in 1Password
//   bun run packages/slack/scripts/slack-setup.ts authorize       # print the OAuth URL to open
//   bun run packages/slack/scripts/slack-setup.ts exchange <code> # auth code -> user token, store it
//   read -rs SLACK_USER_TOKEN && export SLACK_USER_TOKEN          # (alt) paste a token directly
//   bun run packages/slack/scripts/slack-setup.ts token           # store that token
//   bun run packages/slack/scripts/slack-setup.ts prove           # auth.test + conversations.list
//
// Secrets are passed via env vars YOU set with your shell's own `read -rs` (the
// script does NO interactive TTY reading — that proved fragile). Storage/retrieval
// go through 1Password (`op`); the sibling slack.env holds only op:// references
// for ad-hoc `op run --env-file=slack.env -- <cmd>` use.
// Override target with OP_ACCOUNT / OP_VAULT / OP_ITEM env vars.

import { $ } from "bun";

// Operator-specific — supplied via the environment so no 1Password account/vault
// is baked into the repo. Set them in your shell (or a gitignored local file):
//   export OP_ACCOUNT=pushd.1password.com OP_VAULT=Employee
const OP_ACCOUNT = process.env.OP_ACCOUNT ?? "";
const OP_VAULT = process.env.OP_VAULT ?? "";
const OP_ITEM = process.env.OP_ITEM ?? "slack-scout";

function requireOpTarget(): void {
  if (!OP_ACCOUNT || !OP_VAULT) {
    throw new Error(
      "set OP_ACCOUNT and OP_VAULT for your 1Password target, e.g.:\n" +
        "  export OP_ACCOUNT=pushd.1password.com OP_VAULT=Employee\n" +
        "(discover them: `op account list`, `op vault list --account <acct>`)",
    );
  }
}
const REDIRECT_URI = "http://localhost:8080/callback";
const USER_SCOPES = "channels:read,channels:history,users:read";

const ref = (field: string): string => `op://${OP_VAULT}/${OP_ITEM}/${field}`;

// NOTE: this script does NO interactive TTY reading — that proved fragile across
// shells/terminals. Secrets are passed in via env vars that YOU set with your
// shell's own `read -rs` (hidden, reliable), e.g.:
//   read -rs SLACK_CLIENT_SECRET && export SLACK_CLIENT_SECRET
// The script reads them from the env, stores them in 1Password, and unsets
// nothing in your shell (you do that). HTTP + `op` calls are non-interactive
// (op may pop a 1Password/Touch-ID GUI prompt, which is fine).

function requireEnv(name: string, how: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name} first:\n  ${how}`);
  return v;
}

async function itemExists(): Promise<boolean> {
  const r = await $`op item get ${OP_ITEM} --account ${OP_ACCOUNT} --vault ${OP_VAULT}`
    .quiet()
    .nothrow();
  return r.exitCode === 0;
}

/** Run an `op` command, surfacing its real stderr on failure (never echoing args, which may hold a secret). */
async function op(args: string[], what: string): Promise<string> {
  const r = await $`op ${args}`.quiet().nothrow();
  if (r.exitCode !== 0) {
    throw new Error(`${what} failed (op exit ${r.exitCode}):\n${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString();
}

async function opRead(field: string): Promise<string> {
  return (await op(["read", "--account", OP_ACCOUNT, ref(field)], `op read ${ref(field)}`)).trim();
}

async function cmdStore(): Promise<void> {
  const cid = requireEnv("SLACK_CLIENT_ID", "export SLACK_CLIENT_ID=<your app's Client ID>");
  const secret = requireEnv(
    "SLACK_CLIENT_SECRET",
    "read -rs SLACK_CLIENT_SECRET && export SLACK_CLIENT_SECRET   # paste secret, hidden",
  );
  // Build field assignments as whole strings so Bun shell passes them verbatim
  // (the [text]/[password] brackets must not be glob-expanded).
  const idField = `client_id[text]=${cid}`;
  const secretField = `credential[password]=${secret}`;
  if (await itemExists()) {
    await op(
      ["item", "edit", OP_ITEM, "--account", OP_ACCOUNT, "--vault", OP_VAULT, idField, secretField],
      "op item edit",
    );
    console.log(`updated 1Password item '${OP_ITEM}'.`);
  } else {
    await op(
      [
        "item",
        "create",
        "--account",
        OP_ACCOUNT,
        "--vault",
        OP_VAULT,
        "--category",
        "API Credential",
        "--title",
        OP_ITEM,
        idField,
        secretField,
      ],
      "op item create",
    );
    console.log(`created 1Password item '${OP_ITEM}'.`);
  }
}

async function cmdAuthorize(): Promise<void> {
  let cid = process.env.SLACK_CLIENT_ID ?? "";
  if (!cid) {
    requireOpTarget();
    if (await itemExists()) cid = await opRead("client_id");
  }
  if (!cid) throw new Error("set SLACK_CLIENT_ID or run 'store' first");
  const url =
    `https://slack.com/oauth/v2/authorize?client_id=${cid}` +
    `&user_scope=${USER_SCOPES}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  console.log("Open this, click Allow, then copy the ?code= from the localhost redirect:\n");
  console.log(url);
}

async function cmdExchange(code: string): Promise<void> {
  if (!code) throw new Error("usage: slack-setup.ts exchange <code>");
  const clientId = await opRead("client_id");
  const clientSecret = await opRead("credential");
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
  });
  const json = (await (
    await fetch("https://slack.com/api/oauth.v2.access", { method: "POST", body })
  ).json()) as {
    ok: boolean;
    error?: string;
    authed_user?: { access_token?: string; scope?: string; expires_in?: number };
  };
  if (!json.ok || !json.authed_user?.access_token) {
    throw new Error(`exchange failed: ${json.error ?? "no access_token in response"}`);
  }
  const tokenField = `token[password]=${json.authed_user.access_token}`;
  await op(
    ["item", "edit", OP_ITEM, "--account", OP_ACCOUNT, "--vault", OP_VAULT, tokenField],
    "op item edit (store token)",
  );
  console.log(
    `stored user token in '${OP_ITEM}' (scope: ${json.authed_user.scope ?? "?"}, ` +
      `expires_in: ${json.authed_user.expires_in ?? "n/a"}s).`,
  );
}

async function cmdToken(): Promise<void> {
  const token = requireEnv(
    "SLACK_USER_TOKEN",
    "read -rs SLACK_USER_TOKEN && export SLACK_USER_TOKEN   # paste xoxp- token, hidden",
  );
  const tokenField = `token[password]=${token}`;
  await op(
    ["item", "edit", OP_ITEM, "--account", OP_ACCOUNT, "--vault", OP_VAULT, tokenField],
    "op item edit (store token)",
  );
  console.log(`stored user token in '${OP_ITEM}'.`);
}

async function cmdProve(): Promise<void> {
  const token = await opRead("token");
  const headers = { Authorization: `Bearer ${token}` };

  const auth = (await (
    await fetch("https://slack.com/api/auth.test", { headers })
  ).json()) as Record<string, unknown>;
  console.log("== auth.test ==");
  console.log(
    JSON.stringify({ ok: auth.ok, user: auth.user, team: auth.team, error: auth.error }, null, 2),
  );

  const conv = (await (
    await fetch("https://slack.com/api/conversations.list?limit=5&types=public_channel", {
      headers,
    })
  ).json()) as { ok?: boolean; error?: string; channels?: Array<{ id: string; name: string }> };
  console.log("== conversations.list ==");
  console.log(
    JSON.stringify(
      {
        ok: conv.ok,
        error: conv.error,
        channels: (conv.channels ?? []).map((c) => ({ id: c.id, name: c.name })),
      },
      null,
      2,
    ),
  );
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case "store":
      requireOpTarget();
      await cmdStore();
      break;
    case "authorize":
      await cmdAuthorize();
      break;
    case "exchange":
      requireOpTarget();
      await cmdExchange(rest[0] ?? "");
      break;
    case "token":
      requireOpTarget();
      await cmdToken();
      break;
    case "prove":
      requireOpTarget();
      await cmdProve();
      break;
    default:
      console.log(
        "usage: bun run packages/slack/scripts/slack-setup.ts {store|authorize|exchange <code>|token|prove}",
      );
      process.exit(1);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
