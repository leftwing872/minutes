import { useEffect, useMemo, useRef } from "react";
import type { Meeting } from "@minutes/shared";
import { Badge } from "./Badge";
import {
  WEEKDAYS, addDays, dayInfo, dayKey, dayStart, DAY_MS, fmtDayTitle, fmtMonthTitle, fmtTime, fmtWeekTitle, minuteOfDay,
  monthGrid, todayKey, weekDays, type DayInfo,
} from "../lib/time";

export type CalView = "day" | "week" | "month";

export function rangeFor(view: CalView, anchor: string): { fromUtc: string; toUtc: string; days: DayInfo[] } {
  if (view === "day") { const d = dayInfo(anchor); return { fromUtc: iso(dayStart(anchor)), toUtc: iso(dayStart(anchor) + DAY_MS), days: [d] }; }
  if (view === "week") { const days = weekDays(anchor); return { fromUtc: iso(dayStart(days[0]!.key)), toUtc: iso(dayStart(days[6]!.key) + DAY_MS), days }; }
  const { year, month } = dayInfo(anchor);
  const grid = monthGrid(year, month).flat();
  return { fromUtc: iso(dayStart(grid[0]!.key)), toUtc: iso(dayStart(grid[41]!.key) + DAY_MS), days: grid };
}
const iso = (ms: number) => new Date(ms).toISOString();

export function shift(view: CalView, anchor: string, delta: number): string {
  if (view === "day") return addDays(anchor, delta);
  if (view === "week") return addDays(anchor, 7 * delta);
  const d = dayInfo(anchor);
  const m = d.month - 1 + delta, y = d.year + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, mm + 1, 0)).getUTCDate();
  return `${y}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(d.dayOfMonth, last)).padStart(2, "0")}`;
}

export function rangeTitle(view: CalView, anchor: string) {
  if (view === "month") { const d = dayInfo(anchor); return fmtMonthTitle(d.year, d.month); }
  if (view === "day") return fmtDayTitle(anchor);
  return fmtWeekTitle(weekDays(anchor));
}

type DrawerProps = {
  view: CalView; anchor: string; meetings: Meeting[]; selectedId?: string;
  onView: (v: CalView) => void; onAnchor: (k: string) => void; onSelect: (id: string) => void; onClose: () => void;
};

export function CalendarDrawer(p: DrawerProps) {
  const range = useMemo(() => rangeFor(p.view, p.anchor), [p.view, p.anchor]);
  const inRange = useMemo(() => p.meetings.filter((m) => m.startUtc >= range.fromUtc && m.startUtc < range.toUtc), [p.meetings, range]);
  const openDay = (k: string) => { p.onAnchor(k); p.onView("day"); };
  return (
    <section className="calendar-drawer">
      <div className="cd-head">
        <button className="ghost icon" aria-label="이전" onClick={() => p.onAnchor(shift(p.view, p.anchor, -1))}>‹</button>
        <strong>{rangeTitle(p.view, p.anchor)}</strong>
        <button className="ghost icon" aria-label="다음" onClick={() => p.onAnchor(shift(p.view, p.anchor, 1))}>›</button>
        <button className="ghost small" onClick={() => p.onAnchor(todayKey())}>오늘</button>
        <div className="viewswitch">
          {(["day", "week", "month"] as CalView[]).map((v) => (
            <button key={v} className={`ghost small ${p.view === v ? "on" : ""}`} onClick={() => p.onView(v)}>{{ day: "일", week: "주", month: "월" }[v]}</button>
          ))}
        </div>
        <button className="ghost small cd-close" onClick={p.onClose}>닫기</button>
      </div>
      {p.view === "month"
        ? <MonthView days={range.days} month={dayInfo(p.anchor).month} meetings={inRange} selectedId={p.selectedId} onSelect={p.onSelect} onOpenDay={openDay} />
        : <TimeGrid days={range.days} meetings={inRange} selectedId={p.selectedId} onSelect={p.onSelect} />}
    </section>
  );
}

const MAX_CHIPS = 4;
function MonthView(p: { days: DayInfo[]; month: number; meetings: Meeting[]; selectedId?: string; onSelect: (id: string) => void; onOpenDay: (k: string) => void }) {
  const byDay = useMemo(() => {
    const g = new Map<string, Meeting[]>();
    for (const m of p.meetings) { const k = dayKey(m.startUtc); g.set(k, [...(g.get(k) ?? []), m]); }
    for (const v of g.values()) v.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
    return g;
  }, [p.meetings]);
  const today = todayKey();
  return (
    <div className="month">
      <div className="month-head">{WEEKDAYS.map((w, i) => <div key={w} className={`dow w${i}`}>{w}</div>)}</div>
      <div className="month-body">
        {p.days.map((d) => {
          const list = byDay.get(d.key) ?? [];
          return (
            <div key={d.key} className={`cell ${d.month !== p.month ? "out" : ""} ${d.key === today ? "today" : ""} ${d.weekday === 0 || d.weekday === 6 ? "weekend" : ""}`}>
              <button className="cell-date" title="이 날짜 보기" onClick={() => p.onOpenDay(d.key)}>{d.dayOfMonth}</button>
              {list.slice(0, MAX_CHIPS).map((m) => (
                <button key={m.meetingId} className={`chip s-${m.status.toLowerCase()} ${m.meetingId === p.selectedId ? "sel" : ""}`}
                  title={`${fmtTime(m.startUtc)} ${m.title || "(제목 생성 중)"}`} onClick={() => p.onSelect(m.meetingId)}>
                  <span className="chip-time">{fmtTime(m.startUtc)}</span>
                  <span className="chip-title">{m.title || "(제목 생성 중)"}</span>
                  {m.status !== "DONE" && <Badge status={m.status} compact />}
                </button>
              ))}
              {list.length > MAX_CHIPS && <button className="chip more" onClick={() => p.onOpenDay(d.key)}>+{list.length - MAX_CHIPS}건 더</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const HOUR_PX = 48, DEFAULT_START_HOUR = 8, MIN_BLOCK_MIN = 24;
type Block = { m: Meeting; topMin: number; heightMin: number; col: number; cols: number };

function layoutDay(meetings: Meeting[], key: string): Block[] {
  const ds = dayStart(key), de = ds + DAY_MS;
  const items = meetings.map((m) => {
    const s0 = Date.parse(m.startUtc);
    const start = Math.max(s0, ds);
    const end = Math.min(Math.max(s0 + (m.durationSec ?? 0) * 1000, start + 60_000), de);
    const topMin = (start - ds) / 60_000;
    return { m, topMin, heightMin: Math.max((end - start) / 60_000, MIN_BLOCK_MIN), col: 0, cols: 1 };
  }).sort((a, b) => a.topMin - b.topMin);
  // 겹침 클러스터 → greedy 열 배정
  let cluster: Block[] = [], clusterEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    for (const b of cluster) {
      let c = ends.findIndex((e) => e <= b.topMin);
      if (c < 0) { c = ends.length; ends.push(0); }
      ends[c] = b.topMin + b.heightMin; b.col = c;
    }
    for (const b of cluster) b.cols = ends.length;
    cluster = [];
  };
  for (const b of items) {
    if (cluster.length && b.topMin >= clusterEnd) flush();
    cluster.push(b); clusterEnd = Math.max(clusterEnd, b.topMin + b.heightMin);
  }
  if (cluster.length) flush();
  return items;
}

function TimeGrid(p: { days: DayInfo[]; meetings: Meeting[]; selectedId?: string; onSelect: (id: string) => void }) {
  const body = useRef<HTMLDivElement>(null);
  const today = todayKey();
  const layouts = useMemo(() => p.days.map((d) => layoutDay(p.meetings.filter((m) => dayKey(m.startUtc) === d.key), d.key)), [p.days, p.meetings]);
  useEffect(() => {
    const earliest = Math.min(...layouts.flat().map((b) => b.topMin), Infinity);
    const startMin = Number.isFinite(earliest) ? earliest : DEFAULT_START_HOUR * 60;
    if (body.current) body.current.scrollTop = Math.max(0, ((startMin - 30) / 60) * HOUR_PX);
  }, [p.days[0]?.key, p.days.length]);
  const nowMin = minuteOfDay(new Date().toISOString());
  return (
    <div className={`timegrid ${p.days.length === 1 ? "single" : ""}`}>
      <div className="tg-head">
        <div className="tg-gutter" />
        {p.days.map((d) => (
          <div key={d.key} className={`tg-day-head ${d.key === today ? "today" : ""}`}>
            <span className={`dow w${d.weekday}`}>{WEEKDAYS[d.weekday]}</span> <span className="dnum">{d.dayOfMonth}</span>
          </div>
        ))}
      </div>
      <div className="tg-body" ref={body}>
        <div className="tg-inner" style={{ height: 24 * HOUR_PX }}>
          <div className="tg-gutter">
            {Array.from({ length: 24 }, (_, h) => <div key={h} className="tg-hour-label" style={{ height: HOUR_PX }}>{h ? `${String(h).padStart(2, "0")}:00` : ""}</div>)}
          </div>
          {p.days.map((d, i) => (
            <div key={d.key} className={`tg-col ${d.key === today ? "today" : ""}`}>
              {Array.from({ length: 24 }, (_, h) => <div key={h} className="tg-slot" style={{ height: HOUR_PX }} />)}
              {d.key === today && <div className="tg-now" style={{ top: (nowMin / 60) * HOUR_PX }} />}
              {layouts[i]!.map((b) => (
                <button key={b.m.meetingId} className={`tg-block s-${b.m.status.toLowerCase()} ${b.m.meetingId === p.selectedId ? "sel" : ""}`}
                  title={`${fmtTime(b.m.startUtc)} ${b.m.title || "(제목 생성 중)"}`}
                  style={{ top: (b.topMin / 60) * HOUR_PX, height: (b.heightMin / 60) * HOUR_PX, left: `calc(${b.col / b.cols * 100}% + 2px)`, width: `calc(${100 / b.cols}% - 4px)` }}
                  onClick={() => p.onSelect(b.m.meetingId)}>
                  <span className="tg-block-time">{fmtTime(b.m.startUtc)}</span>
                  <span className="tg-block-title">{b.m.title || "(제목 생성 중)"}</span>
                  {b.m.status !== "DONE" && <Badge status={b.m.status} compact />}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
