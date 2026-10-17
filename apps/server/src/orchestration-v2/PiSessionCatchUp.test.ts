import { describe, expect, it } from "vite-plus/test";

import { piMessagesAfterHead } from "./PiSessionCatchUp.ts";

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const message = (id: string, parentId: string | null, role: string, content: unknown) =>
  line({
    type: "message",
    id,
    parentId,
    timestamp: `2026-10-17T09:00:0${id.length}.000Z`,
    message: { role, content },
  });

const session = [
  line({ type: "session", id: "session-uuid", cwd: "/w" }),
  message("a1", null, "user", "first"),
  message("a2", "a1", "assistant", [{ type: "text", text: "answer one" }]),
  line({ type: "session_info", id: "i1", parentId: "a2", name: "Title" }),
  message("t1", "i1", "user", [{ type: "text", text: "from the terminal" }]),
  message("t2", "t1", "assistant", [
    { type: "thinking", thinking: "hidden" },
    { type: "toolCall", name: "bash" },
  ]),
  message("t3", "t2", "toolResult", [{ type: "text", text: "tool output" }]),
  message("t4", "t3", "assistant", [{ type: "text", text: "terminal answer" }]),
].join("\n");

describe("piMessagesAfterHead", () => {
  it("returns the user and assistant text after the head, newest entry as leaf", () => {
    const result = piMessagesAfterHead(session, "a2");
    expect(result?.leafId).toBe("t4");
    expect(result?.messages.map((m) => [m.entryId, m.role, m.text])).toEqual([
      ["t1", "user", "from the terminal"],
      ["t4", "assistant", "terminal answer"],
    ]);
  });

  it("returns nothing new when the head is the newest entry", () => {
    expect(piMessagesAfterHead(session, "t4")).toEqual({ leafId: "t4", messages: [] });
  });

  it("refuses when the newest entry does not descend from the head", () => {
    const branched = `${session}\n${message("b1", "a1", "user", "rewound elsewhere")}`;
    expect(piMessagesAfterHead(branched, "a2")).toBeNull();
  });

  it("refuses an unknown head and skips unreadable lines", () => {
    expect(piMessagesAfterHead(`${session}\nnot json`, "missing")).toBeNull();
    expect(piMessagesAfterHead(`${session}\nnot json`, "a2")?.messages).toHaveLength(2);
  });
});
