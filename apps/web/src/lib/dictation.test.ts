import { describe, expect, it } from "vite-plus/test";

import { DICTATION_AUDIO_CONSTRAINTS, openDictationMicrophone } from "./dictation";

const fakeStream = {} as MediaStream;

describe("openDictationMicrophone", () => {
  it("asks for raw mono audio first", async () => {
    const calls: MediaStreamConstraints[] = [];
    const stream = await openDictationMicrophone(async (constraints) => {
      calls.push(constraints);
      return fakeStream;
    });
    expect(stream).toBe(fakeStream);
    expect(calls).toEqual([DICTATION_AUDIO_CONSTRAINTS]);
    expect(DICTATION_AUDIO_CONSTRAINTS.audio).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    });
  });

  it("falls back to plain audio when the constraints are rejected", async () => {
    const calls: MediaStreamConstraints[] = [];
    const stream = await openDictationMicrophone(async (constraints) => {
      calls.push(constraints);
      if (calls.length === 1) throw new DOMException("bad constraint", "OverconstrainedError");
      return fakeStream;
    });
    expect(stream).toBe(fakeStream);
    expect(calls).toEqual([DICTATION_AUDIO_CONSTRAINTS, { audio: true }]);
  });

  it("does not retry when microphone access is denied", async () => {
    let calls = 0;
    await expect(
      openDictationMicrophone(async () => {
        calls += 1;
        throw new DOMException("denied", "NotAllowedError");
      }),
    ).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(calls).toBe(1);
  });
});
