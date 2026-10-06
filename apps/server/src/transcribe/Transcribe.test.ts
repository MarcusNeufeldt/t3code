// @effect-diagnostics nodeBuiltinImport:off - the ffmpeg stub writes its output file.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import {
  handleTranscribeRequest,
  resolveTranscriptionProvider,
  TRANSCRIBE_MAX_AUDIO_BYTES,
  TRANSCRIBE_ROUTE_PATH,
  type TranscriptionEnv,
} from "./Transcribe.ts";

describe("resolveTranscriptionProvider", () => {
  it("uses ElevenLabs Scribe v2 when a key is set", () => {
    expect(resolveTranscriptionProvider({ ELEVENLABS_API_KEY: "k" })).toEqual({
      kind: "elevenlabs",
      apiKey: "k",
      model: "scribe_v2",
      language: undefined,
    });
  });

  it("honours model and language overrides", () => {
    const provider = resolveTranscriptionProvider({
      ELEVENLABS_API_KEY: "k",
      TRANSCRIBE_MODEL: "scribe_v1",
      TRANSCRIBE_LANGUAGE: "en",
      TRANSCRIBE_PROVIDER: "ElevenLabs",
    });
    expect(provider).toMatchObject({ kind: "elevenlabs", model: "scribe_v1", language: "en" });
  });

  it("reports a missing provider without a key", () => {
    expect(resolveTranscriptionProvider({ ELEVENLABS_API_KEY: "  " })).toEqual({
      kind: "none",
      reason: "no transcription provider configured",
    });
  });

  it("defaults to the local server when TRANSCRIBE_LOCAL_URL is set", () => {
    expect(
      resolveTranscriptionProvider({
        ELEVENLABS_API_KEY: "k",
        TRANSCRIBE_LOCAL_URL: "http://127.0.0.1:8178/",
        TRANSCRIBE_LANGUAGE: "en",
      }),
    ).toEqual({
      kind: "local",
      url: "http://127.0.0.1:8178",
      language: "en",
      fallback: undefined,
    });
  });

  it("uses ElevenLabs when forced even if a local URL is set", () => {
    expect(
      resolveTranscriptionProvider({
        ELEVENLABS_API_KEY: "k",
        TRANSCRIBE_LOCAL_URL: "http://127.0.0.1:8178",
        TRANSCRIBE_PROVIDER: "elevenlabs",
      }),
    ).toMatchObject({ kind: "elevenlabs", apiKey: "k" });
  });

  it("reports a forced local provider without a URL", () => {
    expect(
      resolveTranscriptionProvider({ ELEVENLABS_API_KEY: "k", TRANSCRIBE_PROVIDER: "local" }),
    ).toEqual({ kind: "none", reason: "TRANSCRIBE_LOCAL_URL is not set" });
  });

  it("enables the ElevenLabs fallback only when asked and a key exists", () => {
    const base = { TRANSCRIBE_PROVIDER: "local", TRANSCRIBE_LOCAL_URL: "http://127.0.0.1:8178" };
    expect(resolveTranscriptionProvider({ ...base, ELEVENLABS_API_KEY: "k" })).toMatchObject({
      kind: "local",
      fallback: undefined,
    });
    expect(
      resolveTranscriptionProvider({
        ...base,
        ELEVENLABS_API_KEY: "k",
        TRANSCRIBE_FALLBACK: "ElevenLabs",
      }),
    ).toMatchObject({ kind: "local", fallback: { kind: "elevenlabs", apiKey: "k" } });
    expect(
      resolveTranscriptionProvider({ ...base, TRANSCRIBE_FALLBACK: "elevenlabs" }),
    ).toMatchObject({ kind: "local", fallback: undefined });
  });

  it("rejects providers it does not implement", () => {
    expect(
      resolveTranscriptionProvider({ ELEVENLABS_API_KEY: "k", TRANSCRIBE_PROVIDER: "openrouter" }),
    ).toMatchObject({ kind: "none" });
  });
});

interface Harness {
  readonly ffmpegCalls: Array<ReadonlyArray<string>>;
  readonly providerRequests: Array<HttpClientRequest.HttpClientRequest>;
}

const makeHandler = (
  env: TranscriptionEnv,
  options: {
    readonly ffmpegExitCode?: number;
    readonly providerStatus?: number;
    readonly providerBody?: unknown;
    readonly localStatus?: number;
    readonly localBody?: unknown;
  } = {},
) => {
  const harness: Harness = { ffmpegCalls: [], providerRequests: [] };
  const processRunner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        harness.ffmpegCalls.push(input.args);
        const outputPath = input.args.at(-1);
        if (outputPath !== undefined && (options.ffmpegExitCode ?? 0) === 0) {
          NodeFS.writeFileSync(outputPath, "RIFF-fake-wav");
        }
        return {
          stdout: "",
          stderr: "",
          code: (options.ffmpegExitCode ?? 0) as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      harness.providerRequests.push(request);
      const isLocal = request.url.startsWith("http://127.0.0.1:8178");
      const body = isLocal
        ? (options.localBody ?? { text: "  local words  " })
        : (options.providerBody ?? { text: "  hello world  " });
      const status = isLocal ? (options.localStatus ?? 200) : (options.providerStatus ?? 200);
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
    }),
  );
  const routeLayer = HttpRouter.add(
    "POST",
    TRANSCRIBE_ROUTE_PATH,
    handleTranscribeRequest(() => env).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const { handler, dispose } = HttpRouter.toWebHandler(routeLayer, { disableLogger: true });
  return { handler, dispose, harness };
};

const audioRequest = (field = "audio", bytes: Uint8Array = new Uint8Array([1, 2, 3, 4])) => {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: "audio/webm" }), "voice.webm");
  return new Request(`http://127.0.0.1${TRANSCRIBE_ROUTE_PATH}`, { method: "POST", body: form });
};

describe("POST /api/transcribe", () => {
  it("normalizes with ffmpeg and returns the ElevenLabs transcript", async () => {
    const { handler, dispose, harness } = makeHandler({
      ELEVENLABS_API_KEY: "test-key",
      TRANSCRIBE_LANGUAGE: "en",
    });
    try {
      const response = await handler(audioRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "hello world", provider: "elevenlabs" });

      expect(harness.ffmpegCalls).toHaveLength(1);
      expect(harness.ffmpegCalls[0]).toEqual(
        expect.arrayContaining(["-ar", "16000", "-ac", "1", "-f", "wav"]),
      );

      expect(harness.providerRequests).toHaveLength(1);
      const providerRequest = harness.providerRequests[0]!;
      expect(providerRequest.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
      expect(providerRequest.headers["xi-api-key"]).toBe("test-key");
      expect(providerRequest.body._tag).toBe("FormData");
      if (providerRequest.body._tag === "FormData") {
        expect(providerRequest.body.formData.get("model_id")).toBe("scribe_v2");
        expect(providerRequest.body.formData.get("language_code")).toBe("en");
        expect(providerRequest.body.formData.get("file")).toBeInstanceOf(Blob);
      }
    } finally {
      await dispose();
    }
  });

  it("posts the normalized wav to the local server", async () => {
    const { handler, dispose, harness } = makeHandler({
      ELEVENLABS_API_KEY: "test-key",
      TRANSCRIBE_LOCAL_URL: "http://127.0.0.1:8178",
      TRANSCRIBE_LANGUAGE: "en",
    });
    try {
      const response = await handler(audioRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "local words", provider: "local" });

      expect(harness.ffmpegCalls).toHaveLength(1);
      expect(harness.providerRequests).toHaveLength(1);
      const localRequest = harness.providerRequests[0]!;
      expect(localRequest.url).toBe("http://127.0.0.1:8178/v1/audio/transcriptions");
      expect(localRequest.headers["xi-api-key"]).toBeUndefined();
      expect(localRequest.body._tag).toBe("FormData");
      if (localRequest.body._tag === "FormData") {
        expect(localRequest.body.formData.get("file")).toBeInstanceOf(Blob);
        expect(localRequest.body.formData.get("language")).toBe("en");
      }
    } finally {
      await dispose();
    }
  });

  it("maps local server errors to 502 without falling back by default", async () => {
    const { handler, dispose, harness } = makeHandler(
      { ELEVENLABS_API_KEY: "k", TRANSCRIBE_LOCAL_URL: "http://127.0.0.1:8178" },
      { localStatus: 500, localBody: { detail: "model exploded" } },
    );
    try {
      const response = await handler(audioRequest());
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("HTTP 500");
      expect(body).not.toContain("exploded");
      expect(harness.providerRequests).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it("falls back to ElevenLabs when enabled and the local server fails", async () => {
    const { handler, dispose, harness } = makeHandler(
      {
        ELEVENLABS_API_KEY: "test-key",
        TRANSCRIBE_LOCAL_URL: "http://127.0.0.1:8178",
        TRANSCRIBE_FALLBACK: "elevenlabs",
      },
      { localStatus: 503 },
    );
    try {
      const response = await handler(audioRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "hello world", provider: "elevenlabs" });
      expect(harness.providerRequests.map((request) => request.url)).toEqual([
        "http://127.0.0.1:8178/v1/audio/transcriptions",
        "https://api.elevenlabs.io/v1/speech-to-text",
      ]);
    } finally {
      await dispose();
    }
  });

  it("returns 503 without a provider and never reads the upload", async () => {
    const { handler, dispose, harness } = makeHandler({});
    try {
      const response = await handler(audioRequest());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "no transcription provider configured" });
      expect(harness.ffmpegCalls).toHaveLength(0);
      expect(harness.providerRequests).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it("requires the audio field", async () => {
    const { handler, dispose, harness } = makeHandler({ ELEVENLABS_API_KEY: "k" });
    try {
      const response = await handler(audioRequest("file"));
      expect(response.status).toBe(400);
      expect(harness.providerRequests).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it("rejects non-multipart bodies", async () => {
    const { handler, dispose } = makeHandler({ ELEVENLABS_API_KEY: "k" });
    try {
      const response = await handler(
        new Request(`http://127.0.0.1${TRANSCRIBE_ROUTE_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(400);
    } finally {
      await dispose();
    }
  });

  it("rejects uploads over the size limit", async () => {
    const { handler, dispose, harness } = makeHandler({ ELEVENLABS_API_KEY: "k" });
    try {
      const response = await handler(
        audioRequest("audio", new Uint8Array(TRANSCRIBE_MAX_AUDIO_BYTES + 1)),
      );
      expect(response.status).toBe(413);
      expect(harness.providerRequests).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it("maps undecodable audio to 422", async () => {
    const { handler, dispose, harness } = makeHandler(
      { ELEVENLABS_API_KEY: "k" },
      { ffmpegExitCode: 1 },
    );
    try {
      const response = await handler(audioRequest());
      expect(response.status).toBe(422);
      expect(harness.providerRequests).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it("maps provider errors to 502 without echoing the provider body", async () => {
    const { handler, dispose } = makeHandler(
      { ELEVENLABS_API_KEY: "k" },
      { providerStatus: 401, providerBody: { detail: "secret-ish provider detail" } },
    );
    try {
      const response = await handler(audioRequest());
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("HTTP 401");
      expect(body).not.toContain("secret-ish");
    } finally {
      await dispose();
    }
  });
});
