// prx-psj — content projection: keeps content+identity, drops volatile metadata
// so reaction/reply churn dedups but real edits don't.
import { describe, expect, test } from "bun:test";

import {
  projectSlackContent,
  slackMessageContentJsonSchema,
  SlackMessageContent,
} from "../../src/fetch/slack-content.ts";

describe("projectSlackContent", () => {
  test("keeps content + identity, drops volatile metadata", () => {
    const projected = projectSlackContent({
      ts: "100.1",
      user: "U1",
      type: "message",
      text: "hello",
      blocks: [{ type: "rich_text" }],
      // volatile — all dropped:
      reactions: [{ name: "+1", count: 3 }],
      reply_count: 7,
      latest_reply: "100.9",
      reply_users: ["U2"],
      subscribed: true,
      is_locked: false,
      last_read: "100.8",
      client_msg_id: "abc-123",
      team: "T1",
      edited: { user: "U1", ts: "100.5" },
    });
    expect(projected).toEqual({
      ts: "100.1",
      user: "U1",
      type: "message",
      text: "hello",
      blocks: [{ type: "rich_text" }],
    });
  });

  test("reaction/reply churn leaves the projection identical (dedups)", () => {
    const base = { ts: "100.1", user: "U1", type: "message", text: "hi" };
    const a = projectSlackContent(base);
    const b = projectSlackContent({
      ...base,
      reactions: [{ name: "eyes", count: 1 }],
      reply_count: 4,
      latest_reply: "101.0",
    });
    expect(b).toEqual(a); // identical content → identical projection
  });

  test("a real text edit changes the projection", () => {
    const a = projectSlackContent({ ts: "100.1", text: "before" });
    const b = projectSlackContent({ ts: "100.1", text: "after" });
    expect(b).not.toEqual(a);
  });

  test("identity is kept: same text, different ts → distinct projections", () => {
    const a = projectSlackContent({ ts: "100.1", text: "lgtm" });
    const b = projectSlackContent({ ts: "100.2", text: "lgtm" });
    expect(a).not.toEqual(b);
    expect(a.ts).toBe("100.1");
    expect(b.ts).toBe("100.2");
  });

  test("ts is required (throws on a message without it)", () => {
    expect(() => projectSlackContent({} as { ts: string })).toThrow();
  });

  test("non-string/non-array content fields are dropped, not coerced", () => {
    const projected = projectSlackContent({
      ts: "1.0",
      text: 42 as unknown as string, // wrong type → dropped
      blocks: "nope" as unknown as unknown[], // not an array → dropped
    });
    expect(projected).toEqual({ ts: "1.0" });
  });
});

describe("SlackMessageContent schema + derived JSON Schema", () => {
  test("zod parse strips unknown keys and validates ts", () => {
    const parsed = SlackMessageContent.parse({ ts: "1.0", text: "x", bogus: "drop me" });
    expect(parsed).toEqual({ ts: "1.0", text: "x" });
    expect(() => SlackMessageContent.parse({ ts: "" })).toThrow(); // min(1)
  });

  test("JSON schema requires ts and exposes the content fields", () => {
    const s = slackMessageContentJsonSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(s.properties).sort()).toEqual(
      ["attachments", "blocks", "files", "subtype", "text", "ts", "type", "user"].sort(),
    );
    expect(s.required).toEqual(["ts"]);
  });
});
