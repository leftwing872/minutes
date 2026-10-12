import { useMemo } from "react";
import type { Meeting } from "@minutes/shared";
import { Badge } from "./Badge";
import { dayKey, fmtDayLabel, fmtDuration, fmtTime } from "../lib/time";

export function MeetingList({ meetings, selectedId, query, onQueryChange, onSelect }: {
  meetings: Meeting[]; selectedId?: string; query: string; onQueryChange: (q: string) => void; onSelect: (id: string) => void;
}) {
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (q
      ? meetings.filter((m) => [m.title, m.originalFilename, m.notePreview, ...m.attendees].filter(Boolean).some((s) => s!.toLowerCase().includes(q)))
      : [...meetings]).sort((a, b) => b.startUtc.localeCompare(a.startUtc));
    const g = new Map<string, Meeting[]>();
    for (const m of list) { const k = dayKey(m.startUtc); g.set(k, [...(g.get(k) ?? []), m]); }
    return [...g.entries()];
  }, [meetings, query]);
  const total = groups.reduce((n, [, v]) => n + v.length, 0);
  return (
    <aside className="mlist">
      <div className="mlist-search">
        <input type="search" placeholder="회의 검색" aria-label="회의 검색" value={query} onChange={(e) => onQueryChange(e.target.value)} />
      </div>
      <div className="mlist-body">
        {total === 0 && <div className="muted mlist-empty">{query.trim() ? "검색 결과가 없습니다." : "아직 회의가 없습니다."}</div>}
        {groups.map(([key, list]) => (
          <div key={key} className="mlist-group">
            <div className="mlist-day">{fmtDayLabel(key)}</div>
            {list.map((m) => (
              <button key={m.meetingId} className={`mlist-item ${m.meetingId === selectedId ? "sel" : ""} s-${m.status.toLowerCase()}`} onClick={() => onSelect(m.meetingId)}>
                <div className="mi-top">
                  <span className="mi-time">{fmtTime(m.startUtc)}</span>
                  {m.durationSec ? <span className="mi-dur">{fmtDuration(m.durationSec)}</span> : null}
                  {m.status !== "DONE" && <Badge status={m.status} />}
                </div>
                <div className="mi-title">
                  {m.teamIds.length === 0 && <span className="mi-lock" title="나만 볼 수 있습니다">🔒 </span>}
                  {m.title || m.originalFilename || "제목 없음"}
                </div>
                {m.status === "DONE" && m.notePreview && (
                  <div className="mi-preview">{m.notePreview.replace(/[#*|`\-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90)}</div>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
