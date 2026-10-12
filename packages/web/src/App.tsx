import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Meeting } from "@minutes/shared";
import { isTerminal } from "@minutes/shared";
import { api, type Session } from "./lib/api";
import { useAppAuth } from "./lib/auth";
import { dayKey, todayKey } from "./lib/time";
import { Capture } from "./components/Capture";
import { PendingRecordings } from "./components/PendingRecordings";
import { CalendarDrawer, type CalView } from "./components/Calendar";
import { MeetingList } from "./components/MeetingList";
import { MeetingDetail } from "./components/MeetingDetail";
import { AdminPanel } from "./components/AdminPanel";
import { PasswordModal } from "./components/PasswordModal";

const LOOKBACK_DAYS = 180, LOOKAHEAD_DAYS = 7, POLL_MS = 8000;

/** 폴링 결과를 이전 배열과 비교해 변하지 않은 객체 참조를 유지 (MeetingDetail memo) */
function stableMerge(prev: Meeting[], next: Meeting[]): Meeting[] {
  const byId = new Map(prev.map((m) => [m.meetingId, m]));
  let changed = prev.length !== next.length;
  const out = next.map((m) => {
    const p = byId.get(m.meetingId);
    if (p && JSON.stringify(p) === JSON.stringify(m)) return p;
    changed = true; return m;
  });
  return changed ? out : prev;
}

export function App() {
  const auth = useAppAuth();
  const ready = !auth.enabled || auth.status === "authenticated";
  const [session, setSession] = useState<Session | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState(0);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [adminOpen, setAdminOpen] = useState(false), [menuOpen, setMenuOpen] = useState(false), [pwOpen, setPwOpen] = useState(false), [calOpen, setCalOpen] = useState(false);
  const [view, setView] = useState<CalView>("week");
  const [anchor, setAnchor] = useState(todayKey());
  const meetingsRef = useRef(meetings);
  meetingsRef.current = meetings;

  const loadMeetings = useCallback(async () => {
    try {
      const now = Date.now();
      const list = await api.meetings(new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString(), new Date(now + LOOKAHEAD_DAYS * 86_400_000).toISOString());
      setMeetings((prev) => stableMerge(prev, list));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!ready) return;
    api.session().then(setSession).catch((e) => setAuthError(e.message));
    loadMeetings();
  }, [loadMeetings, ready]);

  const hasActive = meetings.some((m) => !isTerminal(m.status));
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(loadMeetings, POLL_MS);
    return () => clearInterval(t);
  }, [hasActive, loadMeetings]);

  const sortedDesc = useMemo(() => [...meetings].sort((a, b) => b.startUtc.localeCompare(a.startUtc)), [meetings]);
  useEffect(() => { if (!selectedId && sortedDesc.length) setSelectedId(sortedDesc[0]!.meetingId); }, [selectedId, sortedDesc]);
  const selected = meetings.find((m) => m.meetingId === selectedId);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pwOpen) setPwOpen(false); else if (adminOpen) setAdminOpen(false); else if (menuOpen) setMenuOpen(false); else if (calOpen) setCalOpen(false);
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [pwOpen, adminOpen, menuOpen, calOpen]);

  const onCreated = () => { setSelectedId(undefined); setAdminOpen(false); loadMeetings(); };
  const toggleCal = () => {
    if (calOpen) { setCalOpen(false); return; }
    if (sortedDesc[0]) setAnchor(dayKey(sortedDesc[0].startUtc));
    setCalOpen(true);
  };

  if (auth.enabled && auth.status === "loading") return <div className="center">로그인 확인 중…</div>;
  if (auth.enabled && auth.status === "error") return <div className="center"><p>인증 오류: {auth.error}</p><button className="primary" onClick={auth.signin}>다시 로그인</button></div>;
  if (auth.enabled && auth.status === "anonymous") return (
    <div className="center landing">
      <span className="logo big">📝</span>
      <h1>미팅 노트</h1>
      <p className="muted">회의를 녹음하면 전사하고 미팅노트를 만들어 드립니다.</p>
      <button className="primary big" onClick={auth.signin}>로그인</button>
    </div>
  );
  if (authError) return <div className="center"><p>인증 오류: {authError}</p><button className="primary" onClick={() => auth.enabled ? auth.signin() : location.reload()}>다시 로그인</button></div>;
  if (!session) return <div className="center">로그인 확인 중…</div>;
  const teamIds = session.user.teams.map((t) => t.teamId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo">📝</span><strong>미팅 노트</strong></div>
        <Capture anchorDay={anchor} teams={session.user.teams} defaultTeamIds={teamIds.slice(0, 1)} onError={setError} onCreated={onCreated}
          onRecordingChange={setActiveSessionId} onPendingChange={() => setPendingKey((k) => k + 1)} />
        <div className="topbar-right">
          <button className={`ghost ${calOpen ? "on" : ""}`} title="날짜로 찾아보기" onClick={toggleCal}>캘린더</button>
          <div className="menu-wrap">
            <button className="ghost icon" aria-label="메뉴" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>⋯</button>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="menu">
                  <div className="menu-user">
                    <strong>{session.user.email}</strong>
                    <div className="muted small">{teamIds.length ? `${session.user.teams.map((t) => t.name).join(", ")} 팀과 공유` : "개인 · 공유되지 않음"}</div>
                  </div>
                  <button className="ghost" onClick={() => { setPwOpen(true); setMenuOpen(false); }}>비밀번호 변경</button>
                  {session.user.isAdmin && <button className={`ghost ${adminOpen ? "on" : ""}`} onClick={() => { setAdminOpen((v) => !v); setMenuOpen(false); }}>{adminOpen ? "사용자 관리 닫기" : "사용자 관리"}</button>}
                  <button className="ghost" onClick={() => { setMenuOpen(false); if (auth.enabled) auth.signout(); }} title={auth.enabled ? undefined : "로컬 개발 모드에서는 로그아웃이 없습니다"}>로그아웃</button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {error && <div className="alert error"><span>{error}</span><button className="ghost small" onClick={() => setError(null)}>닫기</button></div>}
      <PendingRecordings reloadKey={pendingKey} activeSessionId={activeSessionId} onCreated={onCreated} />
      {calOpen && <CalendarDrawer view={view} anchor={anchor} meetings={meetings} selectedId={selectedId} onView={setView} onAnchor={setAnchor} onSelect={setSelectedId} onClose={() => setCalOpen(false)} />}

      <div className="main">
        <MeetingList meetings={meetings} selectedId={selectedId} query={query} onQueryChange={setQuery} onSelect={(id) => { setSelectedId(id); setAdminOpen(false); }} />
        <section className="reader">
          {adminOpen ? (
            <AdminPanel currentUsername={session.user.username} teams={session.teams} onBack={() => setAdminOpen(false)} onChanged={loadMeetings} />
          ) : selected ? (
            <MeetingDetail meeting={selected} session={session} onChanged={loadMeetings} onClose={() => setSelectedId(undefined)} />
          ) : loading ? (
            <div className="empty">불러오는 중…</div>
          ) : (
            <div className="empty">
              <h2>첫 회의를 기록해 보세요</h2>
              <p className="muted">위의 <strong>녹음 시작</strong>을 누르면 회의를 녹음하고, 끝나면 전사문과 미팅노트를 자동으로 만들어 드립니다.</p>
              <p className="muted small">이미 녹음한 파일이 있다면 <strong>파일 업로드</strong>를 쓰세요.</p>
            </div>
          )}
        </section>
      </div>
      {pwOpen && <PasswordModal onClose={() => setPwOpen(false)} />}
    </div>
  );
}
