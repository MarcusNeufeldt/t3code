/**
 * devbox: "Regenerate title" on a Pi thread runs T3_PI_TITLE_COMMAND (the Pi Session Renamer)
 * with the session file appended; the last stdout JSON with a string `title` wins.
 * T3_PI_TITLE_TIMEOUT_MS bounds it; unset command = T3's own title generation.
 */
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export const PI_TITLE_COMMAND_ENV = "T3_PI_TITLE_COMMAND";
export const PI_TITLE_TIMEOUT_ENV = "T3_PI_TITLE_TIMEOUT_MS";
export const DEFAULT_PI_TITLE_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PI_DRIVER = "pi";
// POSIX or Windows absolute path, as Pi records the session file.
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

export class PiSessionTitleCommandError extends Schema.TaggedError<PiSessionTitleCommandError>()(
  "PiSessionTitleCommandError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PiSessionTitleCommand extends Context.Service<
  PiSessionTitleCommand,
  {
    readonly configured: boolean;
    readonly generateTitle: (
      sessionPath: string,
    ) => Effect.Effect<string, PiSessionTitleCommandError | ProcessRunner.ProcessRunError>;
  }
>()("t3/orchestration-v2/PiSessionTitleCommand") {}

export function parseCommandLine(raw: string | undefined): ReadonlyArray<string> | undefined {
  const tokens = (raw ?? "")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return tokens.length === 0 ? undefined : tokens;
}

export function parseTimeoutMs(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PI_TITLE_TIMEOUT_MS;
}

/** The Pi session file behind the thread's active provider thread, if any. */
export function resolvePiSessionPath(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "providerThreads">,
): string | undefined {
  const activeId = projection.thread.activeProviderThreadId;
  if (activeId == null) return undefined;
  const ref = projection.providerThreads.find((thread) => thread.id === activeId)?.nativeThreadRef;
  const nativeId = ref?.nativeId;
  if (ref?.driver !== PI_DRIVER || typeof nativeId !== "string") return undefined;
  return ABSOLUTE_PATH.test(nativeId) && nativeId.endsWith(".jsonl") ? nativeId : undefined;
}

export type PiTitleOutput =
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "none"; readonly reason: string };

export function readPiTitleOutput(stdout: string): PiTitleOutput {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    const status = typeof record.status === "string" ? record.status : undefined;
    if (status !== undefined && status !== "renamed") {
      const reason = typeof record.reason === "string" ? record.reason : undefined;
      const error = typeof record.error === "string" ? record.error : undefined;
      return { type: "none", reason: [status, reason ?? error].filter(Boolean).join(": ") };
    }
    const title = typeof record.title === "string" ? record.title.trim() : "";
    return title.length > 0
      ? { type: "title", title }
      : { type: "none", reason: "no title in output" };
  }
  return { type: "none", reason: "no JSON result in output" };
}

const tail = (text: string) => (text.length > 500 ? `...${text.slice(-500)}` : text).trim();

export const make = Effect.fn("PiSessionTitleCommand.make")(function* (
  readEnv: () => NodeJS.ProcessEnv = () => process.env,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const env = readEnv();
  const command = parseCommandLine(env[PI_TITLE_COMMAND_ENV]);
  const timeoutMs = parseTimeoutMs(env[PI_TITLE_TIMEOUT_ENV]);

  const generateTitle = Effect.fn("PiSessionTitleCommand.generateTitle")(function* (
    sessionPath: string,
  ) {
    if (command === undefined) {
      return yield* new PiSessionTitleCommandError({
        detail: `${PI_TITLE_COMMAND_ENV} is not set`,
      });
    }
    const result = yield* runner.run({
      command: command[0]!,
      args: [...command.slice(1), sessionPath],
      timeout: Duration.millis(timeoutMs),
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    const output = readPiTitleOutput(result.stdout);
    if (output.type === "title" && result.code === 0) return output.title;
    return yield* new PiSessionTitleCommandError({
      detail: `Pi title command exited ${String(result.code)}: ${
        output.type === "none" ? output.reason : "non-zero exit"
      }${result.stderr.trim().length > 0 ? ` (stderr: ${tail(result.stderr)})` : ""}`,
    });
  });

  return PiSessionTitleCommand.of({ configured: command !== undefined, generateTitle });
});

export const layerFromEnv = (readEnv?: () => NodeJS.ProcessEnv) =>
  Layer.effect(PiSessionTitleCommand, make(readEnv));

export const layer = layerFromEnv();
