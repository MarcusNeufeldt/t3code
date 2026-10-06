import { LoaderCircleIcon, MicIcon, SquareIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import {
  isDictationSupported,
  pickRecorderMimeType,
  transcribeRecording,
} from "../../lib/dictation";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow it in the browser's site settings.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found.";
  }
  if (name === "NotReadableError") {
    return "The microphone is in use by another app.";
  }
  return error instanceof Error && error.message ? error.message : "Could not start recording.";
}

/**
 * Mic toggle for the composer: click to record, click again to stop. The clip
 * is transcribed on the server and handed to `onTranscript`; nothing is sent.
 */
export const ComposerDictationButton = memo(function ComposerDictationButton(props: {
  disabled?: boolean;
  /** Inserts the transcript into the draft; returns false when the composer is busy. */
  onTranscript: (text: string) => boolean;
}) {
  const [supported] = useState(isDictationSupported);
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const discardRef = useRef(false);
  const onTranscriptRef = useRef(props.onTranscript);
  useEffect(() => {
    onTranscriptRef.current = props.onTranscript;
  }, [props.onTranscript]);

  const releaseMicrophone = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(
    () => () => {
      // Unmount (thread switch, navigation): drop the clip and free the mic.
      discardRef.current = true;
      abortRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    },
    [],
  );

  const transcribe = useCallback(async (audio: Blob, mimeType: string | undefined) => {
    const abort = new AbortController();
    abortRef.current = abort;
    setPhase("transcribing");
    try {
      const { text } = await transcribeRecording(audio, mimeType, abort.signal);
      if (discardRef.current) return;
      if (text.length === 0) {
        toastManager.add({ type: "info", title: "No speech detected" });
      } else if (!onTranscriptRef.current(text)) {
        toastManager.add({
          type: "error",
          title: "Could not insert the dictation",
          description: "The composer is busy; try again once it is ready.",
        });
      }
    } catch (error) {
      if (discardRef.current || abort.signal.aborted) return;
      toastManager.add({
        type: "error",
        title: "Dictation failed",
        description: error instanceof Error ? error.message : "Transcription failed.",
      });
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      if (!discardRef.current) setPhase("idle");
    }
  }, []);

  const startRecording = useCallback(async () => {
    setPhase("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setPhase("idle");
      toastManager.add({
        type: "error",
        title: "Microphone unavailable",
        description: microphoneErrorMessage(error),
      });
      return;
    }
    if (discardRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const mimeType = pickRecorderMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      setPhase("idle");
      toastManager.add({
        type: "error",
        title: "Recording is not supported",
        description: microphoneErrorMessage(error),
      });
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      recorderRef.current = null;
      releaseMicrophone();
      if (discardRef.current) return;
      const recordedType = recorder.mimeType || mimeType;
      const audio = new Blob(chunks, recordedType ? { type: recordedType } : undefined);
      if (audio.size === 0) {
        setPhase("idle");
        return;
      }
      void transcribe(audio, recordedType);
    };
    recorderRef.current = recorder;
    streamRef.current = stream;
    recorder.start();
    setPhase("recording");
  }, [releaseMicrophone, transcribe]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      releaseMicrophone();
      setPhase("idle");
    }
  }, [releaseMicrophone]);

  if (!supported) return null;

  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "transcribing";
  const label = recording
    ? "Stop dictation"
    : phase === "transcribing"
      ? "Transcribing..."
      : "Dictate";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={recording ? "ghost-destructive" : "ghost"}
            size="icon-sm"
            data-composer-dictation={phase}
            aria-label={label}
            aria-pressed={recording}
            disabled={busy || (!recording && props.disabled === true)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (recording) {
                stopRecording();
              } else if (phase === "idle") {
                discardRef.current = false;
                void startRecording();
              }
            }}
          />
        }
      >
        {busy ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : recording ? (
          <SquareIcon className="animate-pulse fill-current" />
        ) : (
          <MicIcon />
        )}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
});
