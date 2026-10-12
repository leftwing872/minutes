import { useState } from "react";
import { api } from "../lib/api";
import { useAppAuth } from "../lib/auth";

const RULES: [string, (s: string) => boolean][] = [
  ["12자 이상", (s) => s.length >= 12], ["대문자", (s) => /[A-Z]/.test(s)], ["소문자", (s) => /[a-z]/.test(s)],
  ["숫자", (s) => /\d/.test(s)], ["기호", (s) => /[^A-Za-z0-9]/.test(s)],
];

export function PasswordModal({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState(""), [nw, setNw] = useState(""), [cf, setCf] = useState("");
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [error, setError] = useState<string | null>(null);
  const auth = useAppAuth();
  const ok = RULES.every(([, f]) => f(nw)), match = nw === cf;
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    api.changePassword(cur, nw, auth.accessToken).then(() => setDone(true)).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal" role="dialog" aria-label="비밀번호 변경">
        <div className="ph-row"><h2>비밀번호 변경</h2><button className="ghost icon" aria-label="닫기" onClick={onClose}>✕</button></div>
        {done ? (
          <div className="pw-done"><p>비밀번호가 변경되었습니다.</p><p className="muted small">지금 로그인된 상태는 그대로 유지됩니다. 다음 로그인부터 새 비밀번호를 쓰세요.</p><button className="primary" onClick={onClose}>확인</button></div>
        ) : (
          <form onSubmit={submit}>
            {error && <div className="alert error"><span>{error}</span></div>}
            <label>현재 비밀번호<input type="password" autoComplete="current-password" autoFocus value={cur} onChange={(e) => setCur(e.target.value)} /></label>
            <label>새 비밀번호<input type="password" autoComplete="new-password" value={nw} onChange={(e) => setNw(e.target.value)} /></label>
            <label>새 비밀번호 확인<input type="password" autoComplete="new-password" value={cf} onChange={(e) => setCf(e.target.value)} /></label>
            <div className="pw-rules">{RULES.map(([l, f]) => <span key={l} className={f(nw) ? "met" : ""}>{f(nw) ? "✓" : "·"} {l}</span>)}</div>
            {cf && !match && <div className="pw-error">새 비밀번호가 서로 다릅니다.</div>}
            <div className="cf-actions">
              <button className="primary" disabled={!cur || !ok || !match || busy}>{busy ? "변경 중…" : "변경"}</button>
              <button type="button" className="ghost" onClick={onClose}>취소</button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
