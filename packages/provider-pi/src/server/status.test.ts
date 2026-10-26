import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { checkPiProviderStatus, MINIMUM_PI_VERSION } from "./status.ts";

const encoder = new TextEncoder();
const decodeRpcRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, type: Schema.String })),
);
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) {
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_001),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function piProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.includes("--version")
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

const piDiscoverySpawner = (inventory: unknown, commands: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    let stdinBuffer = "";
    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        stdinBuffer += new TextDecoder().decode(chunk);
        while (true) {
          const newline = stdinBuffer.indexOf("\n");
          if (newline === -1) return;
          const line = stdinBuffer.slice(0, newline);
          stdinBuffer = stdinBuffer.slice(newline + 1);
          if (line.length === 0) continue;
          const request = decodeRpcRequest(line);
          const data =
            request.type === "get_available_models"
              ? inventory
              : request.type === "get_commands"
                ? { commands }
                : {};
          yield* Queue.offer(
            stdout,
            encoder.encode(
              `${encodeJsonLine({ type: "response", id: request.id, command: request.type, success: true, data })}\n`,
            ),
          );
        }
      }),
    );
    return ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      return Effect.succeed(
        args.includes("--version")
          ? processHandle({ stdout: "pi 0.84.3\n" })
          : ChildProcessSpawner.makeHandle({
              ...processHandle({}),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              stdin,
              stdout: Stream.fromQueue(stdout),
            }),
      );
    });
  });

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it.effect("labels models by Pi provider and groups them without changing slugs", () =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner({
        models: [
          { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
          { provider: "claude-bridge", id: "claude-opus-5", name: "Claude Opus 5" },
          { provider: "openrouter", id: "openai/gpt-sol", name: "OpenAI: GPT Sol Latest" },
          { provider: "openai-codex", id: "gpt-6.1-luna", name: "GPT-6.1 Luna" },
          { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
          { provider: "opencode-go", id: "kimi", name: "Kimi" },
          { provider: "xai", id: "grok-5", name: "Grok 5" },
          { provider: "nano-gpt", id: "unnamed-model" },
        ],
      });
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.deepEqual(
        snapshot.models.map((model) => [model.slug, model.name]),
        [
          ["default", "Pi default"],
          ["openai-codex/gpt-6.1-sol", "Codex · GPT-6.1 Sol"],
          ["openai-codex/gpt-6.1-luna", "Codex · GPT-6.1 Luna"],
          ["claude-bridge/claude-opus-5", "Claude · Claude Opus 5"],
          ["openrouter/openai/gpt-sol", "OpenRouter · OpenAI: GPT Sol Latest"],
          ["anthropic/claude-opus-5", "Anthropic · Claude Opus 5"],
          ["opencode-go/kimi", "OpenCode Go · Kimi"],
          ["xai/grok-5", "xAI · Grok 5"],
          ["nano-gpt/unnamed-model", "nano-gpt · unnamed-model"],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("offers fast mode on Codex models only when the /fast extension is loaded", () =>
    Effect.gen(function* () {
      const inventory = {
        models: [
          { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" },
          { provider: "xai", id: "grok-5", name: "Grok 5" },
        ],
      };
      const optionIds = (fast: ReadonlyArray<unknown>, slug: string) =>
        Effect.gen(function* () {
          const spawner = yield* piDiscoverySpawner(inventory, fast);
          const snapshot = yield* checkPiProviderStatus(settings).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          const model = snapshot.models.find((candidate) => candidate.slug === slug);
          return (model?.capabilities?.optionDescriptors ?? []).map((option) => option.id);
        });
      const withFast = [{ name: "fast", source: "extension" }];
      assert.include(yield* optionIds(withFast, "openai-codex/gpt-6-luna"), "fastMode");
      assert.notInclude(yield* optionIds(withFast, "xai/grok-5"), "fastMode");
      assert.notInclude(yield* optionIds([], "openai-codex/gpt-6-luna"), "fastMode");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.80.3")),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
      assert.include(snapshot.message ?? "", `Pi ${MINIMUM_PI_VERSION} or newer`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps compatible Pi selectable when optional discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
      assert.include(snapshot.message ?? "", "could not refresh its models and commands");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a known unauthenticated inventory when Pi returns no usable models", () =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner({ models: [] });
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // regression: #18498 a malformed model inventory must not restore stale Pi models
  it.effect.each([
    ["missing models", {}],
    ["missing model id", { models: [{ provider: "anthropic" }] }],
    [
      "mixed valid and invalid models",
      { models: [{ provider: "anthropic", id: "claude-sonnet-4" }, { provider: "openrouter" }] },
    ],
  ] as const)("reports unknown authentication when Pi discovery returns %s", (_label, inventory) =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner(inventory);
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
