/** Asia/Seoul 기준 날짜 유틸 (동료 앱과 동일한 규칙) */
export const TZ = "Asia/Seoul";
export const TZ_OFFSET = "+09:00";
export const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** ISO/epoch → "YYYY-MM-DD" (서울 날짜) */
export function dayKey(v: string | number): string {
  const t = typeof v === "number" ? v : Date.parse(v);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
}
/** "YYYY-MM-DD" → 그 날 00:00 KST epoch */
export const dayStart = (key: string) => Date.parse(`${key}T00:00:00${TZ_OFFSET}`);
/** 서울 기준 하루 안에서의 분 */
export function minuteOfDay(iso: string) {
  const t = Date.parse(iso);
  return (t - dayStart(dayKey(t))) / 60_000;
}
export const addDays = (key: string, n: number) => dayKey(dayStart(key) + n * DAY_MS + DAY_MS / 2);
export const todayKey = () => dayKey(Date.now());

export type DayInfo = { key: string; year: number; month: number; dayOfMonth: number; weekday: number };
export function dayInfo(key: string): DayInfo {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const weekday = new Date(dayStart(key) + DAY_MS / 2).getUTCDay(); // noon KST → UTC 03:00 same day
  return { key, year: y, month: m, dayOfMonth: d, weekday };
}
/** 주(일요일 시작) 7일 키 */
export function weekDays(key: string): DayInfo[] {
  const info = dayInfo(key);
  const start = addDays(key, -info.weekday);
  return Array.from({ length: 7 }, (_, i) => dayInfo(addDays(start, i)));
}
/** 월 그리드 (일요일 시작, 6주) */
export function monthGrid(year: number, month: number): DayInfo[][] {
  const first = `${year}-${pad(month)}-01`;
  const start = addDays(first, -dayInfo(first).weekday);
  const rows: DayInfo[][] = [];
  for (let r = 0; r < 6; r++) rows.push(Array.from({ length: 7 }, (_, i) => dayInfo(addDays(start, r * 7 + i))));
  return rows;
}

export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function fmtTime(iso: string) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
/** "2026. 10. 11. 09:30" */
export function fmtDateTime(iso: string) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, dateStyle: "medium", timeStyle: "short", hour12: false }).format(new Date(iso));
}
/** "10월 11일 (토)" / 오늘·어제 */
export function fmtDayLabel(key: string) {
  const today = todayKey();
  if (key === today) return "오늘";
  if (key === addDays(today, -1)) return "어제";
  const d = dayInfo(key);
  return `${d.month}월 ${d.dayOfMonth}일 (${WEEKDAYS[d.weekday]})`;
}
export function fmtMonthTitle(year: number, month: number) { return `${year}년 ${month}월`; }
export function fmtWeekTitle(days: DayInfo[]) {
  const a = days[0]!, b = days[6]!;
  return a.month === b.month
    ? `${a.year}년 ${a.month}월 ${a.dayOfMonth}일 – ${b.dayOfMonth}일`
    : `${a.year}년 ${a.month}월 ${a.dayOfMonth}일 – ${b.month}월 ${b.dayOfMonth}일`;
}
export function fmtDayTitle(key: string) {
  const d = dayInfo(key);
  return `${d.year}년 ${d.month}월 ${d.dayOfMonth}일 (${WEEKDAYS[d.weekday]})`;
}
/** 32분 / 1시간 5분 */
export function fmtDuration(sec: number | null | undefined) {
  if (sec == null) return "";
  const m = Math.round(sec / 60);
  if (m < 1) return "1분 미만";
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}
/** 1:05:09 / 5:09 */
export function fmtClock(sec: number) {
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}
export const fmtMs = (ms: number) => fmtClock(ms / 1000);
export function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
/** <input type="datetime-local"> 값(KST) ↔ ISO UTC */
export function isoToLocalInput(iso: string) {
  const t = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}
export function localInputToIso(v: string): string | null {
  const t = Date.parse(`${v}:00${TZ_OFFSET}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
export function fmtRelative(iso: string) {
  const diff = Date.now() - Date.parse(iso);
  const m = Math.round(diff / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return fmtDateTime(iso);
}
