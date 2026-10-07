import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as PiSessionTitle from "./PiSessionTitleCommand.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";

const sessionPath = "/home/u/.pi/agent/sessions/--repo--/2026-10-07_s1.jsonl";
const command = "/usr/bin/node /opt/renamer/cli.mjs --force --json --session";
const threadId = ThreadId.make("thread:pi-title");
const requestId = CommandId.make("command:pi-title:regenerate");
const projectId = ProjectId.make("project:pi-title");
const activeId = ProviderThreadId.make("provider-thread:pi");

const renamerLine = (title: string) =>
  JSON.stringify({ mode: "single", forced: true, status: "renamed", id: "s1", title });

function processOutput(
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput {
  return {
    stdout: `${renamerLine("Flaky deploy root cause and fix")}\n`,
    stderr: "",
    code: 0 as ProcessRunner.ProcessRunOutput["code"],
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
    ...overrides,
  };
}

function projection(
  options: { readonly driver?: string; readonly nativeId?: string; readonly active?: boolean } = {},
) {
  return {
    thread: {
      id: threadId,
      projectId,
      title: "Early title",
      worktreePath: null,
      activeProviderThreadId: options.active === false ? null : activeId,
      titleRegeneration: { requestId },
    },
    messages: [
      {
        id: MessageId.make("message:pi-title"),
        role: "user",
        text: "Look at the flaky deploy",
        attachments: [],
        streaming: false,
      },
    ],
    providerThreads: [
      {
        id: activeId,
        driver: options.driver ?? "pi",
        nativeThreadRef: {
          driver: options.driver ?? "pi",
          nativeId: options.nativeId ?? sessionPath,
          strength: "strong",
        },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

function makeHarness(
  options: {
    readonly projection?: OrchestrationV2ThreadProjection;
    readonly env?: NodeJS.ProcessEnv;
    readonly run?: ProcessRunner.ProcessRunner["Service"]["run"];
  } = {},
) {
  const dispatched: Array<Record<string, unknown>> = [];
  const runs: Array<ProcessRunner.ProcessRunInput> = [];
  const generateThreadTitle = vi.fn(() => Effect.succeed({ title: "Stock title" }));
  const layerThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadRecords: () => Effect.succeed((options.projection ?? projection()) as never),
    dispatch: (cmd) =>
      Effect.sync(() => {
        dispatched.push(cmd as unknown as Record<string, unknown>);
        return {} as never;
      }),
  });
  const layerProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: () => Effect.succeed(Option.some({ projectId, workspaceRoot: "/repo" } as never)),
  });
  const layerRunner = Layer.mock(ProcessRunner.ProcessRunner)({
    run: (input) => {
      runs.push(input);
      return options.run ? options.run(input) : Effect.succeed(processOutput());
    },
  });
  const layerPi = PiSessionTitle.layerFromEnv(
    () => options.env ?? { T3_PI_TITLE_COMMAND: command },
  ).pipe(Layer.provide(layerRunner));
  const layer = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreads,
        layerProjects,
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadTitle }),
        ServerSettings.layerTest({}),
        layerPi,
      ),
    ),
  );
  const completedTitle = () => {
    const complete = dispatched.find((cmd) => cmd.type === "thread.title.regeneration.complete");
    assert.isDefined(complete);
    return complete?.title;
  };
  return { layer, dispatched, runs, generateThreadTitle, completedTitle };
}

const execute = (kind: "regenerate" | "initial") =>
  Effect.gen(function* () {
    const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
    yield* service.execute({
      threadId,
      requestId,
      kind:
        kind === "regenerate"
          ? { type: "regenerate" }
          : { type: "initial", messageId: MessageId.make("message:pi-title") },
    });
  });

describe("PiSessionTitleCommand helpers", () => {
  it("splits the command line and falls back to the default timeout", () => {
    assert.deepEqual(PiSessionTitle.parseCommandLine("  node  /a/cli.mjs --force "), [
      "node",
      "/a/cli.mjs",
      "--force",
    ]);
    assert.isUndefined(PiSessionTitle.parseCommandLine("   "));
    assert.isUndefined(PiSessionTitle.parseCommandLine(undefined));
    assert.equal(PiSessionTitle.parseTimeoutMs("90000"), 90_000);
    assert.equal(PiSessionTitle.parseTimeoutMs("soon"), PiSessionTitle.DEFAULT_PI_TITLE_TIMEOUT_MS);
    assert.equal(PiSessionTitle.parseTimeoutMs(undefined), 180_000);
  });

  it("reads the last JSON result line", () => {
    assert.deepEqual(
      PiSessionTitle.readPiTitleOutput(`warming up\n${renamerLine("  Deploy fix  ")}\n`),
      { type: "title", title: "Deploy fix" },
    );
    assert.deepEqual(
      PiSessionTitle.readPiTitleOutput(
        JSON.stringify({ status: "refused", reason: "subagent_session" }),
      ),
      { type: "none", reason: "refused: subagent_session" },
    );
    assert.equal(PiSessionTitle.readPiTitleOutput("not json").type, "none");
    assert.equal(PiSessionTitle.readPiTitleOutput(renamerLine("   ")).type, "none");
  });

  it("resolves only the active Pi provider thread with an absolute .jsonl file", () => {
    assert.equal(PiSessionTitle.resolvePiSessionPath(projection()), sessionPath);
    assert.isUndefined(PiSessionTitle.resolvePiSessionPath(projection({ driver: "codex" })));
    assert.isUndefined(PiSessionTitle.resolvePiSessionPath(projection({ active: false })));
    assert.isUndefined(
      PiSessionTitle.resolvePiSessionPath(projection({ nativeId: "relative/s1.jsonl" })),
    );
    assert.isUndefined(
      PiSessionTitle.resolvePiSessionPath(projection({ nativeId: "/abs/session-id" })),
    );
  });
});

describe("ThreadTitleRegenerationService with T3_PI_TITLE_COMMAND", () => {
  it.effect("regenerates a Pi thread title with the configured command", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* execute("regenerate");
      assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
      assert.equal(harness.runs.length, 1);
      assert.equal(harness.runs[0]?.command, "/usr/bin/node");
      assert.deepEqual(harness.runs[0]?.args, [
        "/opt/renamer/cli.mjs",
        "--force",
        "--json",
        "--session",
        sessionPath,
      ]);
      assert.equal(Duration.toMillis(Duration.fromInputUnsafe(harness.runs[0]!.timeout!)), 180_000);
      assert.equal(harness.completedTitle(), "Flaky deploy root cause and fix");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("completes without a title when the command fails or times out", () => {
    const harness = makeHarness({
      run: (input) =>
        Effect.fail(
          new ProcessRunner.ProcessTimeoutError({
            command: input.command,
            argumentCount: input.args.length,
            timeoutMs: 180_000,
          }),
        ),
    });
    return Effect.gen(function* () {
      yield* execute("regenerate");
      assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
      assert.isUndefined(harness.completedTitle());
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("completes without a title when the renamer refuses the session", () => {
    const harness = makeHarness({
      run: () =>
        Effect.succeed(
          processOutput({
            stdout: JSON.stringify({ status: "refused", reason: "empty_session" }),
            code: 2 as ProcessRunner.ProcessRunOutput["code"],
          }),
        ),
    });
    return Effect.gen(function* () {
      yield* execute("regenerate");
      assert.isUndefined(harness.completedTitle());
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the stock path for initial titles on Pi threads", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* execute("initial");
      assert.equal(harness.runs.length, 0);
      assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
      assert.equal(harness.completedTitle(), "Stock title");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the stock path for non-Pi threads", () => {
    const harness = makeHarness({ projection: projection({ driver: "codex" }) });
    return Effect.gen(function* () {
      yield* execute("regenerate");
      assert.equal(harness.runs.length, 0);
      assert.equal(harness.completedTitle(), "Stock title");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the stock path when the command is not configured", () => {
    const harness = makeHarness({ env: {} });
    return Effect.gen(function* () {
      yield* execute("regenerate");
      assert.equal(harness.runs.length, 0);
      assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
      assert.equal(harness.completedTitle(), "Stock title");
    }).pipe(Effect.provide(harness.layer));
  });
});
