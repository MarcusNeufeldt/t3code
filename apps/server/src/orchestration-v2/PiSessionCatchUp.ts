import {
  EventId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Devbox: a Pi thread can also be continued in a terminal (`pi-t3`), which
 * appends to the same session file. T3 records only the turns it runs, so this
 * worker copies the terminal's user and assistant messages into the thread:
 * every Pi entry after the thread's conversation head that descends from it.
 * Text only, like the session importer. Tool calls stay in the Pi session.
 */

const EVENT_PREFIX = "pi-catch-up";
/** Leave a file alone while something may still be writing it. */
const QUIET_FILE_MS = 3_000;
/** A T3 turn records its head right after its last write; let that land first. */
const QUIET_PROVIDER_THREAD_MS = 10_000;

export interface PiCatchUpMessage {
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

interface PiEntry {
  readonly parentId: string | null;
  readonly type: string | undefined;
  readonly role: unknown;
  readonly content: unknown;
  readonly timestamp: unknown;
}

function entryText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
}

/**
 * Messages on the branch from `headId` to the session's newest entry (Pi
 * resumes from the newest entry). Null when the newest entry does not descend
 * from the head, for example after the terminal rewound to an earlier point.
 */
export function piMessagesAfterHead(
  contents: string,
  headId: string,
): { readonly leafId: string; readonly messages: ReadonlyArray<PiCatchUpMessage> } | null {
  const entries = new Map<string, PiEntry>();
  let newest: string | null = null;
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    const decoded = decodeJsonLine(line);
    if (Option.isNone(decoded)) continue;
    const record = decoded.value;
    if (typeof record !== "object" || record === null) continue;
    const value = record as Record<string, unknown>;
    if (value["type"] === "session" || typeof value["id"] !== "string") continue;
    const message = (value["message"] ?? {}) as Record<string, unknown>;
    entries.set(value["id"], {
      parentId: typeof value["parentId"] === "string" ? value["parentId"] : null,
      type: typeof value["type"] === "string" ? value["type"] : undefined,
      role: message["role"],
      content: message["content"],
      timestamp: value["timestamp"],
    });
    newest = value["id"];
  }
  if (newest === null || !entries.has(headId)) return null;
  const branch: Array<string> = [];
  const visited = new Set<string>();
  let current: string | null = newest;
  while (current !== null && current !== headId) {
    if (visited.has(current)) return null;
    visited.add(current);
    branch.push(current);
    current = entries.get(current)?.parentId ?? null;
  }
  if (current !== headId) return null;
  const messages: Array<PiCatchUpMessage> = [];
  for (const entryId of branch.toReversed()) {
    const entry = entries.get(entryId);
    if (entry?.type !== "message" || (entry.role !== "user" && entry.role !== "assistant")) {
      continue;
    }
    const text = entryText(entry.content);
    if (text === "" || typeof entry.timestamp !== "string") continue;
    messages.push({ entryId, role: entry.role, text, createdAt: entry.timestamp });
  }
  return { leafId: newest, messages };
}

function messageEvents(
  threadId: ThreadId,
  runId: RunId | null,
  message: PiCatchUpMessage,
  ordinal: number,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const key = `${threadId}:${message.entryId}`;
  const messageId = MessageId.make(`${EVENT_PREFIX}:${key}`);
  const at = DateTime.makeUnsafe(message.createdAt);
  const conversationMessage: OrchestrationV2ConversationMessage = {
    createdBy: message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId,
    runId,
    nodeId: null,
    role: message.role,
    text: message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: TurnItemId.make(`${EVENT_PREFIX}:turn-item:${key}`),
    threadId,
    // Positions are allocated per run; joining the latest run keeps these after it.
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${EVENT_PREFIX}:message:${key}`),
      type: "message.updated",
      threadId,
      occurredAt: at,
      payload: conversationMessage,
    },
    {
      id: EventId.make(`${EVENT_PREFIX}:turn-item:${key}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const makeSweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  // Last file state handled per provider thread, so an unchanged file is one stat.
  const handled = new Map<string, string>();

  /** True when the thread is up to date (or cannot be caught up); false to retry later. */
  const catchUp = Effect.fn("PiSessionCatchUp.catchUp")(function* (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: string;
    readonly file: string;
    readonly head: string;
  }) {
    const records = yield* projections.getThreadRecords(input.threadId, ["providerThreads"]);
    const providerThread: OrchestrationV2ProviderThread | undefined = records.providerThreads.find(
      (candidate) => candidate.id === input.providerThreadId,
    );
    if (
      providerThread === undefined ||
      providerThread.status === "active" ||
      providerThread.nativeThreadRef?.nativeId !== input.file ||
      providerThread.nativeConversationHeadRef?.nativeId !== input.head
    ) {
      return false;
    }
    const now = yield* DateTime.now;
    if (
      DateTime.toEpochMillis(now) - DateTime.toEpochMillis(providerThread.updatedAt) <
      QUIET_PROVIDER_THREAD_MS
    ) {
      return false;
    }
    const contents = yield* fileSystem.readFileString(input.file);
    const result = piMessagesAfterHead(contents, input.head);
    if (result === null) {
      yield* Effect.logInfo("Pi session no longer continues from the thread head; not caught up", {
        threadId: input.threadId,
      });
      return true;
    }
    if (result.messages.length === 0) return true;
    const latestRun = yield* sql<{ readonly run_id: string }>`
      SELECT run_id FROM orchestration_v2_projection_runs
      WHERE thread_id = ${input.threadId} ORDER BY ordinal DESC LIMIT 1
    `;
    const runId = latestRun[0] === undefined ? null : RunId.make(latestRun[0].run_id);
    let ordinal = yield* projections.getNextTurnItemOrdinal(input.threadId);
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const message of result.messages) {
      const itemId = TurnItemId.make(
        `${EVENT_PREFIX}:turn-item:${input.threadId}:${message.entryId}`,
      );
      // A head reset by a stale writer must not copy the same entries twice.
      if ((yield* projections.getTurnItem({ threadId: input.threadId, itemId })) !== null) continue;
      events.push(...messageEvents(input.threadId, runId, message, ordinal));
      ordinal += 1;
    }
    events.push({
      id: EventId.make(`${EVENT_PREFIX}:head:${input.threadId}:${result.leafId}`),
      type: "provider-thread.updated",
      threadId: input.threadId,
      driver: providerThread.driver,
      providerInstanceId: providerThread.providerInstanceId,
      occurredAt: now,
      payload: {
        ...providerThread,
        nativeConversationHeadRef: {
          driver: providerThread.driver,
          nativeId: result.leafId,
          strength: "strong",
        },
        updatedAt: now,
      },
    });
    if (
      records.thread.settledOverride === "settled" &&
      events.some((event) => event.type === "message.updated")
    ) {
      // New terminal turns wake a settled thread, as a new message does.
      events.push({
        id: EventId.make(`${EVENT_PREFIX}:wake:${input.threadId}:${result.leafId}`),
        type: "thread.unsettled",
        threadId: input.threadId,
        providerInstanceId: records.thread.providerInstanceId,
        occurredAt: now,
        payload: {
          ...records.thread,
          settledOverride: null,
          settledAt: null,
          unsettledAt: now,
          updatedAt: now,
        },
      });
    }
    const written = yield* eventSink.writeIfProviderThreadUnchanged({
      expected: providerThread,
      events,
    });
    if (!written.committed) return false;
    yield* Effect.logInfo("Caught up a Pi thread from its session file", {
      threadId: input.threadId,
      messages: events.filter((event) => event.type === "message.updated").length,
    });
    return true;
  });

  return Effect.fn("PiSessionCatchUp.sweep")(function* () {
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly provider_thread_id: string;
      readonly status: string;
      readonly file: string | null;
      readonly head: string | null;
    }>`
      SELECT p.thread_id, p.provider_thread_id, p.status,
        json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS file,
        json_extract(p.payload_json, '$.nativeConversationHeadRef.nativeId') AS head
      FROM orchestration_v2_projection_provider_threads p
      JOIN orchestration_v2_projection_threads t
        ON t.thread_id = p.thread_id AND t.active_provider_thread_id = p.provider_thread_id
      WHERE p.provider = 'pi' AND t.deleted_at IS NULL AND t.archived_at IS NULL
    `;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    for (const row of rows) {
      if (row.status === "active" || row.file === null || row.head === null) continue;
      if (!row.file.startsWith("/")) continue;
      const info = yield* fileSystem.stat(row.file).pipe(Effect.option);
      if (info._tag === "None") continue;
      const mtimeMs = info.value.mtime._tag === "Some" ? info.value.mtime.value.getTime() : 0;
      const state = `${mtimeMs}:${String(info.value.size)}:${row.head}`;
      if (handled.get(row.provider_thread_id) === state) continue;
      if (nowMs - mtimeMs < QUIET_FILE_MS) continue;
      const done = yield* catchUp({
        threadId: ThreadId.make(row.thread_id),
        providerThreadId: row.provider_thread_id,
        file: row.file,
        head: row.head,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Pi session catch-up failed", { threadId: row.thread_id, cause }).pipe(
            Effect.as(true),
          ),
        ),
      );
      if (done) handled.set(row.provider_thread_id, state);
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("pi-session-catch-up", sweep());
  }),
);
