import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
        SqlitePersistence.layerMemory,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layerTest));
});

const piInstanceId = ProviderInstanceId.make("pi");
const piSessionId = "01a11197-d16e-73e2-806a-55ad1649307d";
const piSessionFile = "/home/user/.pi/agent/sessions/--work-project--/2026-10-06_x.jsonl";
const piThreadId = ThreadId.make(`import:${piInstanceId}:${piSessionId}`);

/** The database is shared with the test so it can seed provider threads. */
const makePiImportLayer = (writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>>) =>
  AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AgentSessionScanner.AgentSessionScanner,
          AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            recentThreads: () =>
              Stream.succeed({
                _tag: "Importable",
                source: {
                  provider: "pi",
                  providerInstanceId: piInstanceId,
                  providerSessionId: piSessionId,
                  filePath: piSessionFile,
                  size: 100,
                  mtimeMs: 2,
                  device: 3,
                  inode: 4,
                  birthtimeMs: 1,
                },
                thread: {
                  source: "pi",
                  providerInstanceId: piInstanceId,
                  providerSessionId: piSessionId,
                  title: "BOL-1 INVESTIGATE: Broken deck",
                  model: null,
                  createdAt: "2026-10-06T10:00:00.000Z",
                  updatedAt: "2026-10-06T10:01:00.000Z",
                  messages: [
                    { role: "user", text: "Investigate", createdAt: "2026-10-06T10:00:00.000Z" },
                    { role: "assistant", text: "Found it", createdAt: "2026-10-06T10:01:00.000Z" },
                  ],
                },
              }),
          }),
        ),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/work/project" } as never)),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId: piThreadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: () => Effect.void,
          recordImportedTranscript: () => Effect.void,
        }),
        IdAllocator.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

it.effect("imports a Pi session bound to its session file", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: piThreadId,
      title: "BOL-1 INVESTIGATE: Broken deck",
      providerInstanceId: piInstanceId,
      modelSelection: { instanceId: piInstanceId, model: "default" },
    });
    expect(providerThread?.payload).toMatchObject({
      driver: "pi",
      nativeThreadRef: { driver: "pi", nativeId: piSessionFile, strength: "strong" },
    });
  }).pipe(Effect.provide(makePiImportLayer(writes)));
});

it.effect("skips a Pi session file that already belongs to a T3 thread", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = `{"nativeThreadRef":{"driver":"pi","nativeId":"${piSessionFile}"}}`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
      VALUES ('pt-native', 'thread-native', 'pi', 'idle', '2026-10-06T10:00:00.000Z', ${payload})
    `;
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    expect(writes).toHaveLength(0);
  }).pipe(Effect.provide(makePiImportLayer(writes)));
});
