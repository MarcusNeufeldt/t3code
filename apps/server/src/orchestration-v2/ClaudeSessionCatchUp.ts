import {
  AgentSessionImportSource,
  EventId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as EventSink from "./EventSink.ts";
import { messageEvents, type PiCatchUpMessage } from "./PiSessionCatchUp.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Devbox: copies user/assistant turns that a terminal `claude` session appended to its
 * transcript after the import into the imported thread. Text only, like the importer.
 * The recorded transcript size (importedTranscripts in the runtime payload) is the read
 * offset. Threads that T3 has run are left alone: T3 then owns the conversation.
 */

const EVENT_PREFIX = "claude-catch-up";
/** Leave a file alone while Claude may still be writing it. */
const QUIET_FILE_MS = 5_000;
/** A partial last line at import time is re-read from its start, within this window. */
const LINE_BACKTRACK_BYTES = 64 * 1024;

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeRuntimePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      importedTranscripts: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
);
const decodeImportSource = Schema.decodeUnknownOption(AgentSessionImportSource);

function recordText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: unknown) => {
      if (typeof block !== "object" || block === null) return [];
      const { type, text } = block as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" && text.trim() !== "" ? [text.trim()] : [];
    })
    .join("\n");
}

/**
 * Messages in the complete lines of `chunk` (file bytes from `chunkStart`) that start at
 * or after `offset`, the line holding byte `offset - 1` included when `offset` splits it.
 * `end` is the file offset after the last complete line: the next read starts there.
 */
export function claudeMessagesFrom(
  chunk: Uint8Array,
  chunkStart: number,
  offset: number,
): { readonly end: number; readonly messages: ReadonlyArray<PiCatchUpMessage> } {
  let start = offset - chunkStart;
  if (start > 0 && chunk[start - 1] !== 10) {
    const newline = chunk.lastIndexOf(10, start - 1);
    start = newline === -1 ? start : newline + 1;
  }
  const lastNewline = chunk.lastIndexOf(10);
  if (lastNewline < start) return { end: chunkStart + start, messages: [] };
  const decoder = new TextDecoder();
  const messages: Array<PiCatchUpMessage> = [];
  let lineStart = start;
  while (lineStart <= lastNewline) {
    const lineEnd = chunk.indexOf(10, lineStart);
    const decoded = decodeJsonLine(decoder.decode(chunk.subarray(lineStart, lineEnd)));
    const lineOffset = chunkStart + lineStart;
    lineStart = lineEnd + 1;
    if (Option.isNone(decoded)) continue;
    const record = decoded.value as Record<string, unknown> | null;
    if (typeof record !== "object" || record === null) continue;
    if (record["isSidechain"] === true || record["isMeta"] === true) continue;
    if (record["isCompactSummary"] === true) continue;
    const role = record["type"];
    if (role !== "user" && role !== "assistant") continue;
    const text = recordText((record["message"] as { content?: unknown } | undefined)?.content);
    if (text === "" || typeof record["timestamp"] !== "string") continue;
    messages.push({
      entryId: typeof record["uuid"] === "string" ? record["uuid"] : `offset-${lineOffset}`,
      role,
      text,
      createdAt: record["timestamp"],
    });
  }
  return { end: chunkStart + lastNewline + 1, messages };
}

const makeSweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

  const readRange = (file: string, from: number, to: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fileSystem.open(file, { flag: "r" });
        const bytes = new Uint8Array(to - from);
        let filled = 0;
        while (filled < bytes.length) {
          const read = yield* handle.read(bytes.subarray(filled), {
            position: BigInt(from + filled),
          });
          if (read === 0) break;
          filled += read;
        }
        return bytes.subarray(0, filled);
      }),
    );

  const catchUp = Effect.fn("ClaudeSessionCatchUp.catchUp")(function* (input: {
    readonly threadId: ThreadId;
    readonly source: AgentSessionImportSource;
  }) {
    const info = yield* fileSystem.stat(input.source.filePath).pipe(Effect.option);
    if (Option.isNone(info)) return;
    const size = Number(info.value.size);
    const mtimeMs = Option.match(info.value.mtime, {
      onNone: () => null,
      onSome: (date) => date.getTime(),
    });
    if (size === input.source.size) return;
    if (size < input.source.size) {
      yield* Effect.logInfo("Claude transcript shrank since import; not caught up", {
        threadId: input.threadId,
      });
      return;
    }
    const now = yield* DateTime.now;
    if (mtimeMs !== null && DateTime.toEpochMillis(now) - mtimeMs < QUIET_FILE_MS) return;

    const records = yield* projections.getThreadRecords(input.threadId, ["providerThreads"]);
    const providerThread: OrchestrationV2ProviderThread | undefined = records.providerThreads.find(
      (candidate) => candidate.id === records.thread.activeProviderThreadId,
    );
    if (providerThread === undefined || providerThread.status === "active") return;

    const chunkStart = Math.max(0, input.source.size - LINE_BACKTRACK_BYTES);
    const chunk = yield* readRange(input.source.filePath, chunkStart, size);
    const result = claudeMessagesFrom(chunk, chunkStart, input.source.size);
    let ordinal = yield* projections.getNextTurnItemOrdinal(input.threadId);
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const message of result.messages) {
      const itemId = TurnItemId.make(
        `${EVENT_PREFIX}:turn-item:${input.threadId}:${message.entryId}`,
      );
      if ((yield* projections.getTurnItem({ threadId: input.threadId, itemId })) !== null) continue;
      events.push(...messageEvents(input.threadId, null, message, ordinal, EVENT_PREFIX));
      ordinal += 1;
    }
    if (events.length > 0 && records.thread.settledOverride === "settled") {
      // New terminal turns wake a settled thread, as a new message does.
      events.push({
        id: EventId.make(`${EVENT_PREFIX}:wake:${input.threadId}:${result.end}`),
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
    if (events.length > 0) {
      const written = yield* eventSink.writeIfProviderThreadUnchanged({
        expected: providerThread,
        events,
      });
      if (!written.committed) return;
    }
    if (result.end !== input.source.size) {
      yield* runtimes.recordImportedTranscript({
        threadId: input.threadId,
        source: { ...input.source, size: result.end, mtimeMs },
      });
    }
    if (events.length > 0) {
      yield* Effect.logInfo("Caught up an imported Claude thread from its transcript", {
        threadId: input.threadId,
        messages: events.filter((event) => event.type === "message.updated").length,
      });
    }
  });

  return Effect.fn("ClaudeSessionCatchUp.sweep")(function* () {
    const rows = yield* sql<{ readonly thread_id: string; readonly payload: string | null }>`
      SELECT t.thread_id, r.runtime_payload_json AS payload
      FROM orchestration_v2_projection_threads t
      JOIN provider_session_runtime r ON r.thread_id = t.thread_id
      WHERE r.provider_name = 'claudeAgent'
        AND t.thread_id LIKE 'import:%'
        AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs runs WHERE runs.thread_id = t.thread_id
        )
    `;
    for (const row of rows) {
      const payload = decodeRuntimePayload(row.payload ?? "");
      if (Option.isNone(payload)) continue;
      // A session can be recorded from more than one file; follow the newest.
      const source = (payload.value.importedTranscripts ?? [])
        .flatMap((value) => Option.toArray(decodeImportSource(value)))
        .filter((candidate) => candidate.provider === "claudeAgent")
        .toSorted((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0))[0];
      if (source === undefined || !source.filePath.startsWith("/")) continue;
      yield* catchUp({ threadId: ThreadId.make(row.thread_id), source }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Claude session catch-up failed", {
            threadId: row.thread_id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("claude-session-catch-up", sweep());
  }),
);
