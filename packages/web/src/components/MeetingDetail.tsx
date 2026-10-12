import { memo, useEffect, useState } from "react";
import type { Meeting, Turns, TimeSource } from "@minutes/shared";
import type { Session } from "../lib/api";
import { api, ApiError } from "../lib/api";
import { fmtDateTime, fmtDuration, isoToLocalInput, localInputToIso } from "../lib/time";
import { Badge } from "./Badge";
import { Pipeline } from "./Pipeline";
import { Chat } from "./Chat";
import { Markdown } from "./Markdown";

const TIME_SOURCE: Record<TimeSource, [string, string]> = {
  file: ["파일 메타데이터 기준", "녹음 파일 내부 메타데이터에서 읽은 실제 녹음 시각"],
  manual: ["직접 입력", "직접 입력한 시각"],
  recorder: ["녹음 시각", "브라우저 녹음 시작 시각"],
  upload: ["업로드 시각 추정", "업로드 시각에서 역산한 추정치"],
};

type Props = { meeting: Meeting; session: Session; onChanged: () => void; onClose: () => void };

export const MeetingDetail = memo(function MeetingDetail({ meeting: m, session, onChanged, onClose }: Props) {
  const [tab, setTab] = useState<"note" | "transcript">("note");
  const [note, setNote] = useState<string | undefined>();
  const [turns, setTurns] = useState<Turns | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [editForm, setEditForm] = useState(false);
  const [fTitle, setFTitle] = useState(""), [fStart, setFStart] = useState(""), [fAtt, setFAtt] = useState("");
  const [scopePick, setScopePick] = useState(false);
  const [pickTeams, setPickTeams] = useState<string[]>([]);
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({});
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const canEdit = m.ownerSub === session.user.sub || session.user.isAdmin;
  const resetKey = `${m.meetingId}|${m.title}|${m.startUtc}|${m.attendees.join(",")}|${JSON.stringify(m.speakers)}|${m.teamIds.join(",")}`;
  useEffect(() => {
    setNote(undefined); setTurns(undefined); setError(null); setEditing(false); setEditForm(false); setScopePick(false); setTitleEditing(false);
    setTitleInput(m.title || m.originalFilename || ""); setFTitle(m.title); setFStart(isoToLocalInput(m.startUtc)); setFAtt(m.attendees.join(", "));
    setPickTeams(m.teamIds); setSpeakerMap(m.speakers); setAudioUrl(null);
  }, [resetKey]);

  // DONE 일 때만 지연 로드
  useEffect(() => {
    if (m.status !== "DONE") return;
    if (tab === "note" && note === undefined) api.note(m.meetingId).then(setNote).catch((e) => e instanceof ApiError && e.status === 404 ? setNote("") : setError(e.message));
    if (tab === "transcript" && turns === undefined) api.turns(m.meetingId).then(setTurns).catch((e) => e instanceof ApiError && e.status === 404 ? setTurns({ raw: [], refined: null }) : setError(e.message));
  }, [m.status, tab, note, turns, m.meetingId]);

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };

  const commitTitle = () => {
    setTitleEditing(false);
    const t = titleInput.trim();
    if (!t || t === m.title) { setTitleInput(m.title || m.originalFilename || ""); return; }
    run(async () => { await api.update(m.meetingId, { title: t }); onChanged(); });
  };
  const saveForm = () => {
    const startUtc = localInputToIso(fStart);
    if (!startUtc) { setError("시작 일시 형식이 올바르지 않습니다."); return; }
    run(async () => {
      await api.update(m.meetingId, { title: fTitle.trim(), startUtc, attendees: fAtt.split(",").map((s) => s.trim()).filter(Boolean) });
      setEditForm(false); onChanged();
    });
  };
  const applyScope = () => run(async () => { await api.update(m.meetingId, { teamIds: pickTeams }); setScopePick(false); onChanged(); });
  const saveSpeakers = () => run(async () => { await api.renameSpeakers(m.meetingId, speakerMap); setTurns(undefined); onChanged(); });
  const regenerate = () => {
    if (m.noteEditedAt && !confirm("직접 수정한 노트가 AI 생성 내용으로 덮어써집니다. 계속할까요?")) return;
    run(async () => { await api.regenerateNote(m.meetingId); setNote(undefined); onChanged(); });
  };
  const remove = () => { if (confirm("이 회의를 캘린더에서 삭제할까요?")) run(async () => { await api.remove(m.meetingId); onClose(); onChanged(); }); };
  const retry = () => run(async () => { await api.retry(m.meetingId); onChanged(); });
  const copy = () => {
    const text = tab === "note" ? note ?? "" : (turns?.refined ?? turns?.raw ?? []).map((t) => `${speakerMap[t.speaker] ?? t.speaker}: ${t.text}`).join("\n");
    navigator.clipboard.writeText(text);
  };
  const saveNote = () => { setSaving(true); api.saveNote(m.meetingId, draft).then(() => { setNote(draft); setEditing(false); onChanged(); }).catch((e) => setError(e.message)).finally(() => setSaving(false)); };
  const cancelNote = () => { if (draft === note || confirm("수정한 내용을 버릴까요?")) setEditing(false); };
  const loadAudio = () => api.audioUrl(m.meetingId).then((r) => setAudioUrl(r.url)).catch((e) => setError(e.message));

  const speakerKeys = Array.from(new Set([...Object.keys(m.speakers), ...(turns?.raw ?? []).map((t) => t.speaker)]));
  const teamName = (id: string) => session.teams.find((t) => t.teamId === id)?.name ?? id;
  const ts = TIME_SOURCE[m.timeSource];

  return (
    <article className="panel">
      <header className="panel-head">
        <div className="ph-row">
          {titleEditing && canEdit ? (
            <input className="title-input" autoFocus aria-label="회의 제목" value={titleInput} onChange={(e) => setTitleInput(e.target.value)}
              onBlur={commitTitle} onKeyDown={(e) => { if (e.key === "Enter") commitTitle(); if (e.key === "Escape") { setTitleInput(m.title || m.originalFilename || ""); setTitleEditing(false); } }} />
          ) : (
            <h2 className="title-editable" title={canEdit ? "클릭하면 제목을 바꿉니다" : undefined} onClick={() => canEdit && setTitleEditing(true)}>{m.title || m.originalFilename || "녹음"}</h2>
          )}
          <button className="ghost icon" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="meta">
          <Badge status={m.status} />
          <span>{fmtDateTime(m.startUtc)}</span>
          {m.durationSec ? <span>{fmtDuration(m.durationSec)}</span> : null}
          <span className="hint" title={ts[1]}>{ts[0]}</span>
          {m.noteEditedAt && <span className="hint" title={`${fmtDateTime(m.noteEditedAt)}에 직접 수정`}>직접 수정됨</span>}
          {m.status === "FAILED" && canEdit && <button className="ghost small retry" disabled={busy} onClick={retry}>다시 처리</button>}
        </div>
        {m.attendees.length > 0 && <div className="meta">참석자: {m.attendees.join(", ")}</div>}
        <div className="meta">올린 사람: {m.ownerName}</div>
        <div className="meta scope-row">
          {m.teamIds.length === 0
            ? <span className="scope private" title="나만 볼 수 있습니다">🔒 나만 보기</span>
            : m.teamIds.map((t) => <span key={t} className="scope shared" title={`${teamName(t)} 팀원 모두가 볼 수 있습니다`}>👥 {teamName(t)}</span>)}
          {canEdit && <button className="ghost small" onClick={() => setScopePick((v) => !v)}>공유 범위 변경</button>}
        </div>
        {scopePick && (
          <div className="scope-pick">
            <p className="muted small">공유할 팀을 고르세요. 여러 팀을 선택하면 모두의 캘린더에 나타납니다.</p>
            {session.teams.map((t) => (
              <label key={t.teamId}><input type="checkbox" checked={pickTeams.includes(t.teamId)}
                onChange={(e) => setPickTeams(e.target.checked ? [...pickTeams, t.teamId] : pickTeams.filter((x) => x !== t.teamId))} /> 👥 {t.name} 팀 전체</label>
            ))}
            <label className="scope-private-option"><input type="radio" checked={pickTeams.length === 0} onChange={() => setPickTeams([])} /> 🔒 나만 보기 (공유 안 함)</label>
            <div className="cf-actions"><button className="primary small" disabled={busy} onClick={applyScope}>적용</button><button className="ghost small" onClick={() => setScopePick(false)}>취소</button></div>
          </div>
        )}
      </header>

      {m.status === "FAILED" && m.statusMessage && <div className="alert error"><span>{m.statusMessage}</span></div>}
      {error && <div className="alert error"><span>{error}</span><button className="ghost small" onClick={() => setError(null)}>닫기</button></div>}

      {editForm && (
        <div className="edit-form">
          <label>회의명<input value={fTitle} onChange={(e) => setFTitle(e.target.value)} /></label>
          <label>시작 일시<input type="datetime-local" value={fStart} onChange={(e) => setFStart(e.target.value)} /></label>
          <label>참석자<input placeholder="쉼표로 구분" value={fAtt} onChange={(e) => setFAtt(e.target.value)} /></label>
          <div className="cf-actions"><button className="primary small" disabled={busy} onClick={saveForm}>저장</button><button className="ghost small" onClick={() => setEditForm(false)}>취소</button></div>
        </div>
      )}

      {speakerKeys.length > 0 && m.status === "DONE" && (
        <details className="speakers">
          <summary>화자 이름 지정 ({speakerKeys.length}명)</summary>
          <div className="speaker-rows">
            {speakerKeys.map((s) => (
              <label key={s}><span>{s}</span><input list="attendee-list" placeholder="실제 이름" value={speakerMap[s] ?? ""} disabled={!canEdit}
                onChange={(e) => setSpeakerMap({ ...speakerMap, [s]: e.target.value })} /></label>
            ))}
            <datalist id="attendee-list">{m.attendees.map((a) => <option key={a} value={a} />)}</datalist>
            {canEdit && <button className="primary small" disabled={busy} onClick={saveSpeakers}>저장</button>}
          </div>
        </details>
      )}

      <div className="tabs">
        <button className={`ghost small ${tab === "note" ? "on" : ""}`} onClick={() => setTab("note")}>미팅노트</button>
        <button className={`ghost small ${tab === "transcript" ? "on" : ""}`} onClick={() => setTab("transcript")}>전사문</button>
        <button className="ghost small" title="전문을 클립보드로 복사" disabled={tab === "note" ? note === undefined : turns === undefined} onClick={copy}>복사</button>
        {m.status === "DONE" && <button className="ghost small" onClick={() => audioUrl ? setAudioUrl(null) : loadAudio()}>{audioUrl ? "녹음 닫기" : "녹음 듣기"}</button>}
        <span className="spacer" />
        {canEdit && tab === "note" && note !== undefined && !editing && m.status === "DONE" && <button className="ghost small" onClick={() => { setDraft(note); setEditing(true); }}>노트 수정</button>}
        {canEdit && <button className={`ghost small ${editForm ? "on" : ""}`} onClick={() => setEditForm((v) => !v)}>일정</button>}
        {canEdit && m.status === "DONE" && <button className="ghost small" disabled={busy || editing} onClick={regenerate}>노트 재생성</button>}
        {canEdit && <button className="ghost small danger" disabled={busy} onClick={remove}>삭제</button>}
      </div>

      {audioUrl && <div className="audio-row"><audio controls src={audioUrl} preload="metadata" /></div>}

      <div className="content">
        {m.status !== "DONE" ? (
          <>
            <Pipeline status={m.status} />
            {m.status !== "FAILED" && <p className="muted small">완료되면 자동으로 표시됩니다.</p>}
          </>
        ) : tab === "note" ? (
          note === undefined ? <div className="muted">불러오는 중…</div>
          : editing ? (
            <div className="note-editor">
              <div className="ne-bar">
                <span className="muted small">마크다운으로 편집합니다. <code>##</code> 제목, <code>-</code> 목록, <code>|</code> 표를 쓸 수 있습니다.</span>
                <button className="primary small" disabled={saving || !draft.trim()} onClick={saveNote}>{saving ? "저장 중…" : "저장"}</button>
                <button className="ghost small" onClick={cancelNote}>취소</button>
              </div>
              <div className="ne-split">
                <textarea className="md-src" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
                <div className="ne-preview"><Markdown source={draft} /></div>
              </div>
            </div>
          ) : note ? <Markdown source={note} /> : <p className="muted">노트가 없습니다.</p>
        ) : (
          turns === undefined ? <div className="muted">불러오는 중…</div>
          : <Chat turns={turns.refined ?? turns.raw} speakerMap={m.speakers} refined={!!turns.refined} />
        )}
      </div>
    </article>
  );
});
