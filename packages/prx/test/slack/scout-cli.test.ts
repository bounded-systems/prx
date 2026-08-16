// The shared slack composition root (src/slack/scout-cli.ts) used by both the
// `prx scout slack` verb and the standalone `slack-scout` binary (prx-hkm).
import { describe, expect, test } from "bun:test";

import { execSlackScoutRead } from "../../src/slack/scout-cli.ts";

describe("execSlackScoutRead — composition root", () => {
  test("fails closed when no Slack credential is configured", async () => {
    const saved = { t: process.env.SLACK_TOKEN, b: process.env.SLACK_BOT_TOKEN };
    delete process.env.SLACK_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    try {
      // createServiceKeymaker reads the credential at construction → no token,
      // no read (the keymaker never even mints a key).
      await expect(execSlackScoutRead({ op: "channels" })).rejects.toThrow(/credential/);
    } finally {
      if (saved.t !== undefined) process.env.SLACK_TOKEN = saved.t;
      if (saved.b !== undefined) process.env.SLACK_BOT_TOKEN = saved.b;
    }
  });
});
