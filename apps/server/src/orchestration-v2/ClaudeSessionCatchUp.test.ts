import { describe, expect, it } from "vite-plus/test";

import { claudeMessagesFrom } from "./ClaudeSessionCatchUp.ts";

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const user = (uuid: string, content: unknown) =>
  line({ type: "user", uuid, timestamp: "2026-10-27T10:00:00.000Z", message: { content } });
const assistant = (uuid: string, text: string) =>
  line({
    type: "assistant",
    uuid,
    timestamp: "2026-10-27T10:00:01.000Z",
    message: { content: [{ type: "text", text }] },
  });
const bytes = (text: string) => new TextEncoder().encode(text);

describe("claudeMessagesFrom", () => {
  it("returns user and assistant text after the offset and skips tool and hidden records", () => {
    const imported = user("u1", "first prompt") + assistant("a1", "first answer");
    const later =
      user("u2", "next prompt") +
      user("t1", [{ type: "tool_result", content: "output" }]) +
      line({
        type: "user",
        uuid: "m1",
        isMeta: true,
        timestamp: "x",
        message: { content: "meta" },
      }) +
      assistant("a2", "next answer");
    const file = bytes(imported + later);
    const offset = bytes(imported).length;

    const result = claudeMessagesFrom(file, 0, offset);

    expect(result.end).toBe(file.length);
    expect(result.messages.map((message) => [message.entryId, message.role, message.text])).toEqual(
      [
        ["u2", "user", "next prompt"],
        ["a2", "assistant", "next answer"],
      ],
    );
  });

  it("stops before an unfinished last line and resumes from its start", () => {
    const done = user("u1", "first prompt");
    const partial = assistant("a1", "answer").slice(0, 20);
    const file = bytes(done + partial);

    const result = claudeMessagesFrom(file, 0, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.end).toBe(bytes(done).length);
  });

  it("re-reads a line that the recorded offset splits", () => {
    const first = user("u1", "first prompt");
    const second = assistant("a1", "answer");
    const file = bytes(first + second);
    const chunkStart = 5;
    const offset = bytes(first).length + 10;

    const result = claudeMessagesFrom(file.subarray(chunkStart), chunkStart, offset);

    expect(result.messages.map((message) => message.entryId)).toEqual(["a1"]);
    expect(result.end).toBe(file.length);
  });

  it("returns nothing new when the offset is the end of the file", () => {
    const file = bytes(user("u1", "first prompt"));
    expect(claudeMessagesFrom(file, 0, file.length)).toEqual({ end: file.length, messages: [] });
  });
});
