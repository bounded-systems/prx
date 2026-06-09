#!/usr/bin/env bun
// slack-read-demo.ts — run the FULL read surface against live Slack.
//
// The composition root .9 will formalize: it wires the keymaker
// (slackScopedKeymaker over createServiceKeymaker, which reads SLACK_TOKEN) to
// the Web API transport and drives execSlackRead — so the read is policy-gated,
// authorized by a per-read scoped key, content-addressed, and provenance-ready.
//
// Run with the token injected from 1Password (never in plaintext env):
//   op run --account pushd.1password.com --env-file=packages/slack/slack.env -- \
//     bun run packages/slack/scripts/slack-read-demo.ts channels
//   ... users
//   ... history <channelId>
//   ... thread  <channelId> <ts>

import { createServiceKeymaker } from "@bounded-systems/auth";
import {
  execSlackRead,
  slackReadDerivation,
  slackScopedKeymaker,
  webApiSlackTransport,
  type SlackReadOp,
} from "@bounded-systems/slack";

const [op, a, b] = process.argv.slice(2) as [SlackReadOp, string?, string?];

function paramsFor(): Record<string, unknown> {
  switch (op) {
    case "channels":
      return { limit: 5, types: "public_channel" };
    case "users":
      return { limit: 5 };
    case "history":
      if (!a) throw new Error("usage: ... history <channelId> [limit]");
      return { channel: a, limit: b ? Number(b) : 20 };
    case "thread":
      if (!a || !b) throw new Error("usage: ... thread <channelId> <ts>");
      return { channel: a, ts: b, limit: 5 };
    default:
      throw new Error(`unknown op '${op}' — use channels|users|history|thread`);
  }
}

// Composition root: secret (SLACK_TOKEN) enters only here, sealed into the
// keymaker's closure; the transport stays auth-free.
const keymaker = slackScopedKeymaker(createServiceKeymaker("slack"));
const transport = webApiSlackTransport();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const envelope = await execSlackRead(op, paramsFor() as any, {
  keymaker,
  transport,
  state: "validating",
  role: "executor",
});
const derivation = slackReadDerivation(envelope, { now: Date.now() });

console.log(
  JSON.stringify(
    {
      op: envelope.op,
      policyAllowed: envelope.policy.allowed,
      keyId: envelope.keyId,
      scope: envelope.scope,
      sha256: envelope.sha256,
      producer: derivation.manifest.producer,
      derivationId: derivation.derivationId,
    },
    null,
    2,
  ),
);

// A peek at the actual data the surface read.
const data = envelope.result.data as {
  channels?: Array<{ id: string; name: string }>;
  members?: Array<{ id: string; name: string }>;
  messages?: Array<{ ts: string; user?: string; text?: string }>;
};
if (data.messages) {
  console.log(`messages (${data.messages.length}):`);
  for (const m of data.messages) {
    const text = (m.text ?? "").replace(/\s+/g, " ").trim();
    console.log(`- [${m.ts}] ${m.user ?? "?"}: ${text}`);
  }
} else {
  const rows = data.channels ?? data.members ?? [];
  console.log(
    "first results:",
    rows.slice(0, 10).map((x) => ("name" in x ? x.name : x.id)),
  );
}
