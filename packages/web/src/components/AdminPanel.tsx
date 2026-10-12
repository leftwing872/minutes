import { useEffect, useState } from "react";
import type { AdminUser, Team } from "@minutes/shared";
import { api } from "../lib/api";

export function AdminPanel({ currentUsername, teams, onBack, onChanged }: { currentUsername: string; teams: Team[]; onBack: () => void; onChanged: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(""), [name, setName] = useState(""), [team, setTeam] = useState("");
  const [handover, setHandover] = useState<{ email: string; password: string } | null>(null);
  const allTeams = Array.from(new Set([...teams.map((t) => t.teamId), ...users.flatMap((u) => u.teams.map((t) => t.teamId))])).sort();

  const load = () => api.adminUsers().then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    const teamId = team.trim().toLowerCase();
    if (!email.trim() || !teamId) { setError("이메일과 팀을 모두 입력해 주세요."); return; }
    run(async () => {
      const r = await api.inviteUser({ email: email.trim(), name: name.trim() || email.split("@")[0]!, teamId });
      setHandover({ email: r.email, password: r.password }); setEmail(""); setName("");
    });
  };
  const handoverText = (h: { email: string; password: string }) =>
    `미팅 노트에 초대되었습니다.\n\n주소: ${window.location.origin}\n아이디: ${h.email}\n임시 비밀번호: ${h.password}\n\n첫 로그인 시 새 비밀번호를 정하게 됩니다. 7일 안에 로그인해 주세요.`;

  return (
    <article className="panel admin">
      <button className="ghost small back" onClick={onBack}>‹ 회의로 돌아가기</button>
      <h2>사용자 관리</h2>
      <div className="alert warn"><span>로컬 개발 모드: 사용자/팀은 로컬 SQLite에 저장되며 실제 로그인은 없습니다. 배포 시 Cognito User Pool과 연결됩니다.</span></div>
      {error && <div className="alert error"><span>{error}</span><button className="ghost small" onClick={() => setError(null)}>닫기</button></div>}
      <form className="invite" onSubmit={invite}>
        <h3>사용자 초대</h3>
        <label>이메일<input type="email" required placeholder="colleague@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>이름<input placeholder="표시 이름" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>팀<input list="team-list" required placeholder="platform-team" value={team} onChange={(e) => setTeam(e.target.value)} /></label>
        <datalist id="team-list">{allTeams.map((t) => <option key={t} value={t} />)}</datalist>
        <p className="muted small">같은 팀에 속한 사람은 서로의 회의·전사문·노트를 모두 볼 수 있습니다. 팀 이름을 새로 입력하면 팀이 생성됩니다.</p>
        <button className="primary" disabled={busy}>계정 만들기</button>
      </form>
      {handover && (
        <div className="handover">
          <strong>계정이 만들어졌습니다. 아래 정보를 본인에게 전달하세요.</strong>
          <p className="muted small">임시 비밀번호는 저장되지 않으므로 이 창을 닫으면 다시 볼 수 없습니다. 첫 로그인 때 본인이 새 비밀번호를 정하게 됩니다. 7일 안에 로그인해야 합니다.</p>
          <div className="ho-row"><span className="ho-label">주소</span><code>{window.location.origin}</code></div>
          <div className="ho-row"><span className="ho-label">아이디</span><code>{handover.email}</code></div>
          <div className="ho-row"><span className="ho-label">임시 비밀번호</span><code className="ho-secret">{handover.password}</code></div>
          <div className="cf-actions">
            <button className="primary small" onClick={() => navigator.clipboard.writeText(handoverText(handover))}>안내문 전체 복사</button>
            <button className="ghost small" onClick={() => setHandover(null)}>닫기</button>
          </div>
        </div>
      )}
      <h3>사용자 {users.length}명</h3>
      <div className="user-list">
        {users.map((u) => {
          const me = u.username === currentUsername;
          const notIn = allTeams.filter((t) => !u.teams.some((x) => x.teamId === t));
          return (
            <div key={u.username} className="user-row">
              <div className="ur-main">
                <strong>{u.email}</strong>{u.name && <span className="muted"> {u.name}</span>}
                {u.isAdmin && <span className="badge done">관리자</span>}
                {me && <span className="badge pending">나</span>}
                {u.status === "FORCE_CHANGE_PASSWORD" && <span className="badge working" title="임시 비밀번호로 첫 로그인 대기 중">로그인 대기</span>}
              </div>
              <div className="ur-teams">
                {u.teams.length === 0 && <span className="muted small">팀 없음 (개인 회의만 보임)</span>}
                {u.teams.map((t) => (
                  <span key={t.teamId} className="team-tag">{t.name}<button className="tag-x" title="이 팀에서 제외" disabled={busy} onClick={() => run(() => api.setUserTeam(u.username, t.teamId, true))}>✕</button></span>
                ))}
                {notIn.length > 0 && (
                  <select value="" disabled={busy} onChange={(e) => e.target.value && run(() => api.setUserTeam(u.username, e.target.value))}>
                    <option value="">＋ 팀 추가</option>{notIn.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
                <button className="ghost small" title="새 팀을 만들어 이 사용자를 넣습니다" disabled={busy} onClick={() => {
                  const t = prompt("만들 팀 이름 (영문 소문자·숫자·하이픈, 2~31자)", "")?.trim().toLowerCase();
                  if (t) run(() => api.setUserTeam(u.username, t));
                }}>＋ 새 팀</button>
              </div>
              <div className="ur-actions">
                {u.status === "FORCE_CHANGE_PASSWORD" && <button className="ghost small" title="임시 비밀번호를 다시 발급합니다" disabled={busy}
                  onClick={() => run(async () => { const r = await api.resetTemporaryPassword(u.username); setHandover({ email: r.email, password: r.password }); })}>비밀번호 재발급</button>}
                {!me && <button className="ghost small" disabled={busy} onClick={() => run(() => api.setUserAdmin(u.username, u.isAdmin))}>{u.isAdmin ? "관리자 해제" : "관리자 지정"}</button>}
                {!me && <button className="ghost small danger" disabled={busy} onClick={() => confirm(`${u.email} 계정을 삭제할까요?`) && run(() => api.deleteUser(u.username))}>삭제</button>}
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}
