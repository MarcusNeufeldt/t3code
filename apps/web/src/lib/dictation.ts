import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

/** Server route that turns a recorded clip into text (see apps/server/src/transcribe). */
export const DICTATION_ROUTE_PATH = "/api/transcribe";

const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

/**
 * Microphone capture needs a secure context (HTTPS or localhost) and
 * MediaRecorder. Plain-HTTP tailnet or LAN URLs have no `mediaDevices`.
 */
export function isDictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext !== false &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

/**
 * Raw-ish capture for speech-to-text: browser echo cancellation, noise
 * suppression and gain control tend to smear consonants the model needs.
 */
export const DICTATION_AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
};

/**
 * Opens the microphone with {@link DICTATION_AUDIO_CONSTRAINTS}, retrying with
 * `{ audio: true }` when the browser rejects those constraints. A denied
 * permission is rethrown as is, so the user is not prompted twice.
 */
export async function openDictationMicrophone(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream> = (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
): Promise<MediaStream> {
  try {
    return await getUserMedia(DICTATION_AUDIO_CONSTRAINTS);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") throw error;
    return await getUserMedia({ audio: true });
  }
}

/** First container the browser can record; Safari/iOS lands on audio/mp4. */
export function pickRecorderMimeType(
  isTypeSupported: (mimeType: string) => boolean = (mimeType) =>
    MediaRecorder.isTypeSupported(mimeType),
): string | undefined {
  return RECORDER_MIME_TYPES.find((mimeType) => {
    try {
      return isTypeSupported(mimeType);
    } catch {
      return false;
    }
  });
}

export function dictationFileName(mimeType: string | undefined): string {
  const base = (mimeType ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (base === "audio/mp4") return "voice.m4a";
  if (base === "audio/ogg") return "voice.ogg";
  return "voice.webm";
}

export interface DictationResult {
  readonly text: string;
  readonly provider: string;
}

function readErrorMessage(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return null;
}

/**
 * Sends a recorded clip to the primary environment. Browser sessions are
 * same-origin and use the session cookie; the desktop app sends its bearer token.
 */
export async function transcribeRecording(
  audio: Blob,
  mimeType: string | undefined,
  signal?: AbortSignal,
): Promise<DictationResult> {
  const url = resolvePrimaryEnvironmentHttpUrl(DICTATION_ROUTE_PATH);
  const bearerToken = await readDesktopPrimaryBearerToken().catch(() => null);
  const form = new FormData();
  form.append("audio", audio, dictationFileName(mimeType));
  const response = await fetch(url, {
    method: "POST",
    body: form,
    credentials: bearerToken ? "omit" : "include",
    ...(bearerToken ? { headers: { authorization: `Bearer ${bearerToken}` } } : {}),
    ...(signal ? { signal } : {}),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Not authorized to transcribe on this server.");
    }
    throw new Error(readErrorMessage(body) ?? `Transcription failed (HTTP ${response.status}).`);
  }
  if (typeof body !== "object" || body === null || !("text" in body)) {
    throw new Error("Transcription returned an unexpected response.");
  }
  const { text, provider } = body as { text: unknown; provider?: unknown };
  return {
    text: typeof text === "string" ? text.trim() : "",
    provider: typeof provider === "string" ? provider : "unknown",
  };
}
