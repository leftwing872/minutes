import { useCallback, useEffect, useRef, useState } from "react";
import { recordings, type RecordingSession } from "./recordings";

export const TIMESLICE_MS = 5000;
export type RecorderStatus = "idle" | "starting" | "recording" | "paused" | "stopping";

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];
  return cands.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}
export const recorderSupported = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined" && window.isSecureContext;

/**
 * MediaRecorder 래퍼. chunk 는 IndexedDB 에 즉시 저장되므로 메모리에 누적하지 않는다.
 * elapsedSec 은 일시정지 시간을 제외한 실제 녹음 시간.
 */
export function useRecorder() {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<RecordingSession | null>(null);

  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const seq = useRef(0);
  const activeSince = useRef<number | null>(null); // 현재 녹음 구간 시작 (perf.now)
  const accumulated = useRef(0); // 이전 구간 누적 ms
  const sessionRef = useRef<RecordingSession | null>(null);

  const total = () => accumulated.current + (activeSince.current != null ? performance.now() - activeSince.current : 0);

  useEffect(() => {
    if (status !== "recording") return;
    const t = setInterval(() => setElapsedSec(total() / 1000), 250);
    return () => clearInterval(t);
  }, [status]);

  // 주기적으로 세션 durationSec 저장 (복구 시 사용)
  useEffect(() => {
    if (status !== "recording" && status !== "paused") return;
    const t = setInterval(() => {
      const s = sessionRef.current;
      if (s) recordings.update(s.sessionId, { durationSec: total() / 1000 }).catch(() => {});
    }, 10_000);
    return () => clearInterval(t);
  }, [status]);

  const cleanup = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null; rec.current = null;
  };

  const start = useCallback(async (meta: Pick<RecordingSession, "title" | "attendees" | "teamIds">) => {
    setError(null);
    if (!recorderSupported()) { setError("이 브라우저는 녹음을 지원하지 않습니다."); return null; }
    const mimeType = pickMimeType();
    if (mimeType === null) { setError("이 브라우저는 녹음을 지원하지 않습니다."); return null; }
    setStatus("starting");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e: any) {
      setStatus("idle");
      setError(e?.name === "NotAllowedError" ? "마이크 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요."
        : e?.name === "NotFoundError" ? "사용할 수 있는 마이크를 찾을 수 없습니다." : `녹음 중 오류가 발생했습니다. ${e?.message ?? ""}`);
      return null;
    }
    const s: RecordingSession = {
      sessionId: crypto.randomUUID(), startedAtUtc: new Date().toISOString(),
      mimeType: mimeType || "audio/webm", state: "recording", durationSec: 0, durationEstimated: false,
      stoppedAtUtc: null, lastError: null, uploadedMeetingId: null, ...meta,
    };
    await recordings.put(s);
    sessionRef.current = s; setSession(s);
    seq.current = 0; accumulated.current = 0; activeSince.current = performance.now(); setElapsedSec(0);

    const mr = new MediaRecorder(stream.current!, mimeType ? { mimeType, audioBitsPerSecond: 64_000 } : undefined);
    rec.current = mr;
    mr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recordings.addChunk(s.sessionId, seq.current++, ev.data).catch((e) => setError(`저장 실패: ${e.message}`));
    };
    mr.onerror = () => setError("녹음 중 오류가 발생했습니다.");
    mr.start(TIMESLICE_MS);
    setStatus("recording");
    return s;
  }, []);

  const pause = useCallback(() => {
    if (rec.current?.state !== "recording") return;
    rec.current.pause();
    accumulated.current = total(); activeSince.current = null;
    setStatus("paused");
  }, []);
  const resume = useCallback(() => {
    if (rec.current?.state !== "paused") return;
    rec.current.resume(); activeSince.current = performance.now();
    setStatus("recording");
  }, []);

  /** 중단: 저장만 하고 세션 반환 (삭제하지 않음) */
  const stop = useCallback(async (): Promise<RecordingSession | null> => {
    const mr = rec.current, s = sessionRef.current;
    if (!mr || !s) return null;
    setStatus("stopping");
    const dur = total() / 1000;
    await new Promise<void>((res) => {
      mr.onstop = () => res();
      if (mr.state === "inactive") res(); else mr.stop();
    });
    // 마지막 ondataavailable 이 onstop 이후 처리될 수 있어 잠시 대기
    await new Promise((r) => setTimeout(r, 150));
    cleanup();
    const done: RecordingSession = { ...s, state: "stopped", durationSec: dur, stoppedAtUtc: new Date().toISOString() };
    await recordings.put(done);
    sessionRef.current = null; setSession(null);
    setStatus("idle"); setElapsedSec(0);
    return done;
  }, []);

  useEffect(() => () => cleanup(), []);
  return { status, elapsedSec, error, session, start, pause, resume, stop };
}
