import * as ByteSize from "effect/ByteSize";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Multipart from "effect/http/Multipart";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Server-side speech-to-text for composer dictation.
 *
 * The browser records a short clip (webm/opus, mp4/aac, ...) and posts it as
 * the multipart field `audio`. The clip is normalized to 16 kHz mono wav with
 * ffmpeg and sent to ElevenLabs Scribe. Audio and keys are never logged.
 *
 * Environment (read per request, so the service EnvironmentFile applies):
 * - ELEVENLABS_API_KEY   enables the ElevenLabs provider
 * - TRANSCRIBE_MODEL     ElevenLabs model id, default scribe_v2
 * - TRANSCRIBE_LANGUAGE  optional language_code (e.g. "en"); auto-detect when unset
 * - TRANSCRIBE_PROVIDER  optional; only "elevenlabs" is supported
 * - TRANSCRIBE_FFMPEG    optional ffmpeg path, default "ffmpeg" from PATH
 */

export const TRANSCRIBE_ROUTE_PATH = "/api/transcribe";
export const TRANSCRIBE_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const FFMPEG_TIMEOUT = "60 seconds";
const PROVIDER_TIMEOUT = "90 seconds";
const ELEVENLABS_SPEECH_TO_TEXT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const DEFAULT_ELEVENLABS_MODEL = "scribe_v2";
export const NO_TRANSCRIPTION_PROVIDER_MESSAGE = "no transcription provider configured";

export type TranscriptionEnv = Readonly<Record<string, string | undefined>>;

export type TranscriptionProviderConfig =
  | {
      readonly kind: "elevenlabs";
      readonly apiKey: string;
      readonly model: string;
      readonly language: string | undefined;
    }
  | { readonly kind: "none"; readonly reason: string };

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function resolveTranscriptionProvider(env: TranscriptionEnv): TranscriptionProviderConfig {
  const forced = nonEmpty(env.TRANSCRIBE_PROVIDER)?.toLowerCase();
  if (forced !== undefined && forced !== "elevenlabs") {
    return { kind: "none", reason: `transcription provider "${forced}" is not supported` };
  }
  const apiKey = nonEmpty(env.ELEVENLABS_API_KEY);
  if (apiKey === undefined) {
    return { kind: "none", reason: NO_TRANSCRIPTION_PROVIDER_MESSAGE };
  }
  return {
    kind: "elevenlabs",
    apiKey,
    model: nonEmpty(env.TRANSCRIBE_MODEL) ?? DEFAULT_ELEVENLABS_MODEL,
    language: nonEmpty(env.TRANSCRIBE_LANGUAGE),
  };
}

class TranscribeRequestError extends Data.TaggedError("TranscribeRequestError")<{
  readonly status: number;
  readonly message: string;
}> {}

const errorResponse = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );

const multipartFailure = (error: Multipart.MultipartError) => {
  switch (error.reason._tag) {
    case "FileTooLarge":
    case "BodyTooLarge":
      return new TranscribeRequestError({
        status: 413,
        message: `audio is larger than ${TRANSCRIBE_MAX_AUDIO_BYTES / (1024 * 1024)} MB`,
      });
    case "InternalError":
      return new TranscribeRequestError({ status: 500, message: "could not read the upload" });
    default:
      return new TranscribeRequestError({ status: 400, message: "invalid multipart upload" });
  }
};

const ElevenLabsResponse = Schema.Struct({ text: Schema.optional(Schema.String) });

const readAudioUpload = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return yield* new TranscribeRequestError({
      status: 400,
      message: "expected multipart/form-data with an audio field",
    });
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > TRANSCRIBE_MAX_AUDIO_BYTES + MULTIPART_OVERHEAD_BYTES
  ) {
    return yield* new TranscribeRequestError({
      status: 413,
      message: `audio is larger than ${TRANSCRIBE_MAX_AUDIO_BYTES / (1024 * 1024)} MB`,
    });
  }
  const persisted = yield* request.multipart.pipe(
    Effect.provideService(Multipart.MaxParts, 8),
    Effect.provideService(Multipart.MaxFieldSize, ByteSize.kilobytes(64)),
    Effect.provideService(Multipart.MaxFileSize, ByteSize.bytes(TRANSCRIBE_MAX_AUDIO_BYTES)),
    Effect.provideService(
      HttpServerRequest.MaxBodySize,
      ByteSize.bytes(TRANSCRIBE_MAX_AUDIO_BYTES + MULTIPART_OVERHEAD_BYTES),
    ),
    Effect.mapError(multipartFailure),
  );
  const field = persisted["audio"];
  const file =
    Array.isArray(field) && field.length > 0 && Multipart.isPersistedFile(field[0])
      ? field[0]
      : undefined;
  if (file === undefined) {
    return yield* new TranscribeRequestError({ status: 400, message: "audio file required" });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem
    .stat(file.path)
    .pipe(
      Effect.mapError(
        () => new TranscribeRequestError({ status: 500, message: "could not read the upload" }),
      ),
    );
  if (Number(info.size) === 0) {
    return yield* new TranscribeRequestError({ status: 400, message: "audio file is empty" });
  }
  return file.path;
});

/** ffmpeg any-format input to 16 kHz mono wav (same normalization as pi-hub). */
const normalizeToWav = Effect.fn("transcribe.normalizeToWav")(function* (
  inputPath: string,
  ffmpegCommand: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const failConversion = (message: string) => new TranscribeRequestError({ status: 422, message });

  const workDir = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "t3-transcribe-" })
    .pipe(Effect.mapError(() => failConversion("could not prepare audio conversion")));
  const wavPath = path.join(workDir, "audio.wav");
  const result = yield* processRunner
    .run({
      command: ffmpegCommand,
      args: [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        wavPath,
      ],
      timeout: FFMPEG_TIMEOUT,
      maxOutputBytes: 64 * 1024,
      outputMode: "truncate",
    })
    .pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Dictation audio conversion failed to run", { reason: error._tag }),
      ),
      Effect.mapError(() => failConversion("audio conversion failed (is ffmpeg installed?)")),
    );
  if (result.code !== 0) {
    yield* Effect.logWarning("Dictation audio conversion exited with an error", {
      code: result.code,
    });
    return yield* failConversion("could not decode the recorded audio");
  }
  return yield* fileSystem
    .readFile(wavPath)
    .pipe(Effect.mapError(() => failConversion("could not read the converted audio")));
});

const transcribeWithElevenLabs = Effect.fn("transcribe.elevenlabs")(function* (
  wav: Uint8Array,
  provider: Extract<TranscriptionProviderConfig, { kind: "elevenlabs" }>,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const form = new FormData();
  form.append("model_id", provider.model);
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  if (provider.language !== undefined) {
    form.append("language_code", provider.language);
  }
  const providerFailure = (message: string) => new TranscribeRequestError({ status: 502, message });

  const response = yield* httpClient
    .execute(
      HttpClientRequest.post(ELEVENLABS_SPEECH_TO_TEXT_URL).pipe(
        HttpClientRequest.setHeader("xi-api-key", provider.apiKey),
        HttpClientRequest.bodyFormData(form),
      ),
    )
    .pipe(
      Effect.timeout(PROVIDER_TIMEOUT),
      Effect.tapError((error) =>
        Effect.logWarning("Dictation provider request failed", {
          provider: "elevenlabs",
          reason: error._tag,
        }),
      ),
      Effect.mapError(() => providerFailure("transcription provider request failed")),
    );
  if (response.status < 200 || response.status >= 300) {
    yield* Effect.logWarning("Dictation provider returned an error status", {
      provider: "elevenlabs",
      status: response.status,
    });
    return yield* providerFailure(`transcription provider returned HTTP ${response.status}`);
  }
  const body = yield* HttpClientResponse.schemaBodyJson(ElevenLabsResponse)(response).pipe(
    Effect.mapError(() => providerFailure("transcription provider returned an invalid response")),
  );
  return (body.text ?? "").trim();
});

/**
 * Handles POST /api/transcribe after authentication. Returns `{ text, provider }`
 * or `{ error }` with 400/413/422/502/503.
 */
export const handleTranscribeRequest = (readEnv: () => TranscriptionEnv = () => process.env) =>
  Effect.gen(function* () {
    const env = readEnv();
    const provider = resolveTranscriptionProvider(env);
    if (provider.kind === "none") {
      return errorResponse(503, provider.reason);
    }
    const ffmpegCommand = nonEmpty(env.TRANSCRIBE_FFMPEG) ?? "ffmpeg";
    const inputPath = yield* readAudioUpload;
    const wav = yield* normalizeToWav(inputPath, ffmpegCommand);
    const text = yield* transcribeWithElevenLabs(wav, provider).pipe(
      // The provider request carries the API key header; keep it out of traces.
      Effect.withTracerEnabled(false),
    );
    return HttpServerResponse.jsonUnsafe(
      { text, provider: provider.kind },
      { headers: { "cache-control": "no-store" } },
    );
  }).pipe(
    Effect.scoped,
    Effect.catchTag("TranscribeRequestError", (error) =>
      Effect.succeed(errorResponse(error.status, error.message)),
    ),
  );
