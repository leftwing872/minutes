import { useEffect, useState } from "react";
import { api, uploadToS3 } from "../lib/api";
import { recordings, recordingFilename, type RecordingSession } from "../lib/recordings";
import { TIMESLICE_MS } from "../lib/useRecorder";
import { fmtBytes, fmtClock, fmtDateTime } from "../lib/time";

const MIN_BYTES = 2048;
type Row = RecordingSession & { bytes: number };

/** 브라우저에만 저장된(업로드되지 않은) 녹음 목록 */
export function PendingRecordings({ reloadKey, activeSessionId, onCreated }: {
  reloadKey: number; activeSessionId?: string; onCreated: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ratio, setRatio] = useState<number | undefined>();

  async function load() {
    try {
      await recordings.recoverOrphans(TIMESLICE_MS);
      const all = await recordings.list();
      const out: Row[] = [];
      for (const s of all) {
        if (s.sessionId === activeSessionId) continue;
        const bytes = await recordings.bytes(s.sessionId);
        if (bytes < MIN_BYTES) { await recordings.remove(s.sessionId); continue; }
        out.push({ ...s, bytes });
      }
      setRows(out); setError(null);
    } catch { setError("이 브라우저의 녹음 저장소를 읽지 못했습니다. 서버에 저장된 회의는 정상입니다."); }
  }
  useEffect(() => { load(); }, [reloadKey, activeSessionId]);

  async function upload(r: Row) {
    setBusyId(r.sessionId); setRatio(undefined);
    try {
      const blob = await recordings.blob(r.sessionId, r.mimeType);
      const res = await api.createUpload({
        filename: recordingFilename(r), contentType: r.mimeType, startUtc: r.startedAtUtc, durationSec: r.durationSec,
        timeSource: "recorder", title: r.title || undefined, attendees: r.attendees, teamIds: r.teamIds,
      });
      await uploadToS3(res.uploadUrl, blob, r.mimeType, setRatio);
      await api.completeUpload(res.meetingId);
      await recordings.remove(r.sessionId);
      onCreated();
    } catch (e: any) {
      await recordings.update(r.sessionId, { lastError: e.message });
    } finally { setBusyId(null); load(); }
  }
  async function download(r: Row) {
    const blob = await recordings.blob(r.sessionId, r.mimeType);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = recordingFilename(r); a.click();
    URL.revokeObjectURL(url);
  }
  async function remove(r: Row) {
    if (!confirm(`이 녹음(${fmtBytes(r.bytes)})을 완전히 삭제할까요? 복구할 수 없습니다.`)) return;
    await recordings.remove(r.sessionId); load();
  }

  if (!rows.length && !error) return null;
  return (
    <div className="pending">
      <div className="pending-head">
        <strong>업로드되지 않은 녹음 {rows.length}건</strong>
        <span className="muted small">이 브라우저에만 저장되어 있습니다. 업로드하면 전사가 시작됩니다.</span>
      </div>
      {error && <div className="alert error"><span>{error}</span></div>}
      {rows.map((r) => (
        <div key={r.sessionId} className="pending-row">
          <div className="pr-info">
            <div>{fmtDateTime(r.startedAtUtc)}{r.title ? ` · ${r.title}` : ""}</div>
            <div className="muted small">{fmtClock(r.durationSec)} · {fmtBytes(r.bytes)}{r.durationEstimated ? " · 길이 추정" : ""}</div>
            {r.lastError && <div className="pr-error">{r.lastError.startsWith("세션 정보가") ? r.lastError : `업로드 실패: ${r.lastError}`}</div>}
          </div>
          {busyId === r.sessionId ? (
            <div className="progress small-bar"><div className="bar" style={{ width: `${Math.round((ratio ?? 0) * 100)}%` }} /><span>{ratio === undefined ? "처리 중…" : `${Math.round(ratio * 100)}%`}</span></div>
          ) : (
            <div className="pr-actions">
              <button className="primary small" disabled={!!busyId} onClick={() => upload(r)}>업로드</button>
              <button className="ghost small" disabled={!!busyId} onClick={() => download(r)}>파일로 저장</button>
              <button className="ghost small danger" disabled={!!busyId} onClick={() => remove(r)}>삭제</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
