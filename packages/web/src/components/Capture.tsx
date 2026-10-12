import { useEffect, useRef, useState } from "react";
import type { Team } from "@minutes/shared";
import { api, uploadToS3 } from "../lib/api";
import { useRecorder, recorderSupported } from "../lib/useRecorder";
import { recordings, recordingFilename, type RecordingSession } from "../lib/recordings";
import { readFileMeta } from "../lib/audioMeta";
import { fmtClock, localInputToIso, isoToLocalInput } from "../lib/time";

type Props = {
  anchorDay: string;
  teams: Team[];
  defaultTeamIds: string[];
  onError: (msg: string) => void;
  onCreated: () => void;
  onRecordingChange: (activeSessionId: string | undefined) => void;
  onPendingChange: () => void;
};

/** 상단바 캡처 패널: 녹음 / 파일 업로드 / 드래그앤드롭 */
export function Capture(p: Props) {
  const rec = useRecorder();
  const [uploading, setUploading] = useState<{ ratio?: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [startInput, setStartInput] = useState("");
  const [title, setTitle] = useState("");
  const [attendees, setAttendees] = useState("");
  const [teamIds, setTeamIds] = useState<string[]>(p.defaultTeamIds);
  const [metaHint, setMetaHint] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { p.onRecordingChange(rec.session?.sessionId); }, [rec.session?.sessionId]);
  useEffect(() => { if (rec.error) p.onError(rec.error); }, [rec.error]);
  useEffect(() => {
    if (rec.status !== "recording" && rec.status !== "paused") return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [rec.status]);

  const live = rec.status === "recording" || rec.status === "paused";

  async function startRecording() {
    await rec.start({ title: "", attendees: [], teamIds: p.defaultTeamIds });
    p.onPendingChange();
  }

  /** 종료 후 전사 */
  async function finishAndUpload() {
    const s = await rec.stop();
    p.onPendingChange();
    if (!s) { p.onError("녹음을 찾을 수 없습니다."); return; }
    await uploadSession(s);
  }

  async function abandon() {
    await rec.stop();
    p.onPendingChange();
  }

  async function uploadSession(s: RecordingSession) {
    setUploading({});
    try {
      const blob = await recordings.blob(s.sessionId, s.mimeType);
      const name = recordingFilename(s);
      const r = await api.createUpload({
        filename: name, contentType: s.mimeType, startUtc: s.startedAtUtc, durationSec: s.durationSec,
        timeSource: "recorder", title: s.title || undefined, attendees: s.attendees, teamIds: s.teamIds,
      });
      await uploadToS3(r.uploadUrl, blob, s.mimeType, (ratio) => setUploading({ ratio }));
      await api.completeUpload(r.meetingId);
      await recordings.remove(s.sessionId);
      p.onPendingChange();
      p.onCreated();
    } catch (e: any) {
      await recordings.update(s.sessionId, { lastError: e.message });
      p.onPendingChange();
      p.onError(`${e.message} 아래 목록에서 다시 업로드할 수 있습니다.`);
    } finally { setUploading(null); }
  }

  async function pickFile(f: File) {
    setFile(f);
    setStartInput(`${p.anchorDay}T09:00`);
    setMetaHint(null);
    const meta = await readFileMeta(f);
    if (meta.recordedAtUtc) {
      setStartInput(isoToLocalInput(meta.recordedAtUtc));
      setMetaHint("파일 메타데이터에서 녹음 시각을 읽었습니다.");
    }
  }

  async function uploadFile() {
    if (!file) return;
    const startUtc = localInputToIso(startInput);
    if (!startUtc) { p.onError("회의 시작 일시를 입력해 주세요."); return; }
    const f = file;
    const meta = await readFileMeta(f);
    resetForm();
    setUploading({});
    try {
      const contentType = f.type || "application/octet-stream";
      const r = await api.createUpload({
        filename: f.name, contentType, startUtc,
        durationSec: meta.durationSec ?? undefined,
        timeSource: meta.recordedAtUtc && isoToLocalInput(meta.recordedAtUtc) === startInput ? "file" : "manual",
        title: title.trim() || undefined,
        attendees: attendees.split(",").map((s) => s.trim()).filter(Boolean),
        teamIds,
      });
      await uploadToS3(r.uploadUrl, f, contentType, (ratio) => setUploading({ ratio }));
      await api.completeUpload(r.meetingId);
      p.onCreated();
    } catch (e: any) { p.onError(e.message); }
    finally { setUploading(null); }
  }

  function resetForm() { setFile(null); setTitle(""); setAttendees(""); setStartInput(""); setMetaHint(null); setTeamIds(p.defaultTeamIds); }

  return (
    <div className={`capture ${dragging ? "dragging" : ""}`}>
      <div className="capture-main"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f && !live && !uploading) pickFile(f); }}>
        {uploading ? (
          <div className="progress">
            <div className="bar" style={{ width: `${Math.round((uploading.ratio ?? 0) * 100)}%` }} />
            <span>{uploading.ratio === undefined ? "처리 중…" : `${Math.round(uploading.ratio * 100)}%`}</span>
          </div>
        ) : live ? (
          <div className="rec-live">
            <span className={`rec-dot ${rec.status === "recording" ? "on" : ""}`} aria-hidden="true" />
            <span className="rec-time">{fmtClock(rec.elapsedSec)}</span>
            {rec.status === "recording"
              ? <button className="ghost small" onClick={rec.pause}>일시정지</button>
              : <button className="ghost small" onClick={rec.resume}>계속</button>}
            <button className="primary small" onClick={finishAndUpload}>종료 후 전사</button>
            <button className="ghost small" title="녹음을 멈추고 보관합니다 (삭제하지 않음)" onClick={abandon}>중단</button>
          </div>
        ) : (
          <>
            {recorderSupported()
              ? <button className="primary" onClick={startRecording} disabled={rec.status === "starting"}>● 녹음 시작</button>
              : <span className="hint" title="HTTPS와 MediaRecorder 지원이 필요합니다">이 브라우저에서는 녹음을 쓸 수 없습니다</span>}
            <button onClick={() => fileInput.current?.click()}>파일 업로드</button>
            <span className="hint">끌어다 놓기도 됩니다</span>
            <input ref={fileInput} type="file" hidden accept="audio/*,video/mp4,.m4a,.mp3,.wav,.mp4,.webm,.ogg,.flac"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ""; }} />
          </>
        )}
      </div>

      {file && (
        <div className="capture-form">
          <div className="cf-file"><span>{file.name}</span><span className="muted">{(file.size / 1024 / 1024).toFixed(1)} MB</span></div>
          <label>회의 시작 일시 *<input type="datetime-local" required value={startInput} onChange={(e) => setStartInput(e.target.value)} /></label>
          <p className="cf-hint muted small">{metaHint ?? "길이는 파일에서 읽어 종료 시각을 계산합니다. 녹음 시각이 파일에 들어 있으면 (아이폰 음성 메모 등) 그 값을 우선합니다."}</p>
          <label>회의명<input value={title} placeholder="비워 두면 전사 후 자동 생성" onChange={(e) => setTitle(e.target.value)} /></label>
          <label>참석자<input value={attendees} placeholder="쉼표로 구분 — 화자 이름 추정에 사용됩니다" onChange={(e) => setAttendees(e.target.value)} /></label>
          {p.teams.length > 0 && (
            <label>공유 범위
              <select value={teamIds[0] ?? ""} onChange={(e) => setTeamIds(e.target.value ? [e.target.value] : [])}>
                <option value="">🔒 나만 보기</option>
                {p.teams.map((t) => <option key={t.teamId} value={t.teamId}>👥 {t.name} 팀 전체</option>)}
              </select>
            </label>
          )}
          <div className="cf-actions">
            <button className="primary" onClick={uploadFile}>업로드</button>
            <button className="ghost" onClick={resetForm}>취소</button>
          </div>
        </div>
      )}
    </div>
  );
}
