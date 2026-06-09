#!/usr/bin/env bun
// slack-setup.ts — provision + prove the slack-scout read token. Secrets live in
// 1Password; this script never writes them to disk or shell history.
//
//   bun run packages/slack/scripts/slack-setup.ts store           # store Client ID + Secret
//   bun run packages/slack/scripts/slack-setup.ts authorize       # print the OAuth URL to open
//   bun run packages/slack/scripts/slack-setup.ts exchange <code> # auth code -> user token, store it
//   bun run packages/slack/scripts/slack-setup.ts token           # paste an xoxp- token, store it
//   bun run packages/slack/scripts/slack-setup.ts prove           # auth.test + conversations.list
//
// Secret input is read hidden from the TTY (requires an interactive terminal).
// Storage/retrieval go through 1Password (`op`); the sibling slack.env holds only
// op:// references for ad-hoc `op run --env-file=slack.env -- <cmd>` use.
// Override target with OP_ACCOUNT / OP_VAULT / OP_ITEM env vars.

import { $ } from "bun";

const OP_ACCOUNT = process.env.OP_ACCOUNT ?? "my.1password.com";
const OP_VAULT = process.env.OP_VAULT ?? "Private";
const OP_ITEM = process.env.OP_ITEM ?? "slack-scout";
const REDIRECT_URI = "http://localhost:8080/callback";
const USER_SCOPES = "channels:read,channels:history,users:read";

const ref = (field: string): string => `op://${OP_VAULT}/${OP_ITEM}/${field}`;

/** Read one line of hidden input from the TTY (echo off). Needs an interactive terminal. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("no TTY — run this in an interactive terminal so secret input stays hidden");
  }
  process.stderr.write(prompt);
  // Delegate the hidden read to the shell's `read -rs` over the inherited TTY.
  const proc = Bun.spawn(["bash", "-c", 'IFS= read -rs v; printf %s "$v"'], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const secret = await new Response(proc.stdout).text();
  await proc.exited;
  process.stderr.write("\n");
  return secret;
}

/** Read one line of visible input (for non-secret values like Client ID). */
async function readLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  for await (const line of console) return line.trim();
  return "";
}

async function itemExists(): Promise<boolean> {
  const r = await $`op item get ${OP_ITEM} --account ${OP_ACCOUNT} --vault ${OP_VAULT}`
    .quiet()
    .nothrow();
  return r.exitCode === 0;
}

async function opRead(field: string): Promise<string> {
  return (await $`op read --account ${OP_ACCOUNT} ${ref(field)}`.text()).trim();
}

async function cmdStore(): Promise<void> {
  let cid = process.env.SLACK_CLIENT_ID ?? "";
  if (!cid) cid = await readLine("Client ID (visible): ");
  const secret = await readSecret("Client Secret (hidden): ");
  // Build field assignments as whole strings so Bun shell passes them verbatim
  // (the [text]/[password] brackets must not be glob-expanded).
  const idField = `client_id[text]=${cid}`;
  const secretField = `credential[password]=${secret}`;
  if (await itemExists()) {
    await $`op item edit ${OP_ITEM} --account ${OP_ACCOUNT} --vault ${OP_VAULT} ${idField} ${secretField}`.quiet();
    console.log(`updated 1Password item '${OP_ITEM}'.`);
  } else {
    const category = "API Credential";
    await $`op item create --account ${OP_ACCOUNT} --vault ${OP_VAULT} --category ${category} --title ${OP_ITEM} ${idField} ${secretField}`.quiet();
    console.log(`created 1Password item '${OP_ITEM}'.`);
  }
}

async function cmdAuthorize(): Promise<void> {
  let cid = process.env.SLACK_CLIENT_ID ?? "";
  if (!cid && (await itemExists())) cid = await opRead("client_id");
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
  await $`op item edit ${OP_ITEM} --account ${OP_ACCOUNT} --vault ${OP_VAULT} ${tokenField}`.quiet();
  console.log(
    `stored user token in '${OP_ITEM}' (scope: ${json.authed_user.scope ?? "?"}, ` +
      `expires_in: ${json.authed_user.expires_in ?? "n/a"}s).`,
  );
}

async function cmdToken(): Promise<void> {
  const token = await readSecret("Paste the xoxp- user token (hidden): ");
  const tokenField = `token[password]=${token}`;
  await $`op item edit ${OP_ITEM} --account ${OP_ACCOUNT} --vault ${OP_VAULT} ${tokenField}`.quiet();
  console.log(`stored user token in '${OP_ITEM}'.`);
}

async function cmdProve(): Promise<void> {
  const token = await opRead("token");
  const headers = { Authorization: `Bearer ${token}` };

  const auth = (await (
    await fetch("https://slack.com/api/auth.test", { headers })
  ).json()) as Record<string, unknown>;
  console.log("== auth.test ==");
  console.log(JSON.stringify({ ok: auth.ok, user: auth.user, team: auth.team, error: auth.error }, null, 2));

  const conv = (await (
    await fetch("https://slack.com/api/conversations.list?limit=5&types=public_channel", { headers })
  ).json()) as { ok?: boolean; error?: string; channels?: Array<{ id: string; name: string }> };
  console.log("== conversations.list ==");
  console.log(
    JSON.stringify(
      { ok: conv.ok, error: conv.error, channels: (conv.channels ?? []).map((c) => ({ id: c.id, name: c.name })) },
      null,
      2,
    ),
  );
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case "store":
      await cmdStore();
      break;
    case "authorize":
      await cmdAuthorize();
      break;
    case "exchange":
      await cmdExchange(rest[0] ?? "");
      break;
    case "token":
      await cmdToken();
      break;
    case "prove":
      await cmdProve();
      break;
    default:
      console.log("usage: bun run packages/slack/scripts/slack-setup.ts {store|authorize|exchange <code>|token|prove}");
      process.exit(1);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
