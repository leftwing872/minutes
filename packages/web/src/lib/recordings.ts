/**
 * 브라우저 로컬 녹음 저장소 (IndexedDB).
 * 녹음 중 5초마다 chunk 를 저장해 탭이 닫히거나 브라우저가 죽어도 복구할 수 있다.
 * 업로드 성공 전까지 삭제하지 않는다.
 */
export type RecordingState = "recording" | "stopped" | "uploaded";
export type RecordingSession = {
  sessionId: string;
  startedAtUtc: string;
  mimeType: string;
  state: RecordingState;
  /** 일시정지 제외 실제 녹음 시간. 복구된 세션은 추정치일 수 있음 */
  durationSec: number;
  durationEstimated: boolean;
  stoppedAtUtc: string | null;
  title: string;
  attendees: string[];
  teamIds: string[];
  /** 마지막 업로드 오류 메시지 */
  lastError: string | null;
  uploadedMeetingId: string | null;
};
type ChunkRow = { key: string; sessionId: string; seq: number; blob: Blob };

const DB = "minutes-recordings", V = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, V);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "sessionId" });
      if (!db.objectStoreNames.contains("chunks")) {
        const s = db.createObjectStore("chunks", { keyPath: "key" });
        s.createIndex("bySession", "sessionId");
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = <T,>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

export const recordings = {
  async list(): Promise<RecordingSession[]> {
    const db = await open();
    const all = await tx<RecordingSession[]>(db, "sessions", "readonly", (s) => s.getAll());
    db.close();
    return all.sort((a, b) => b.startedAtUtc.localeCompare(a.startedAtUtc));
  },
  async get(id: string): Promise<RecordingSession | undefined> {
    const db = await open();
    const r = await tx<RecordingSession | undefined>(db, "sessions", "readonly", (s) => s.get(id));
    db.close(); return r;
  },
  async put(s: RecordingSession) {
    const db = await open();
    await tx(db, "sessions", "readwrite", (st) => st.put(s));
    db.close();
  },
  async update(id: string, patch: Partial<RecordingSession>) {
    const cur = await this.get(id);
    if (cur) await this.put({ ...cur, ...patch });
  },
  async addChunk(sessionId: string, seq: number, blob: Blob) {
    const db = await open();
    const row: ChunkRow = { key: `${sessionId}:${String(seq).padStart(6, "0")}`, sessionId, seq, blob };
    await tx(db, "chunks", "readwrite", (s) => s.put(row));
    db.close();
  },
  async chunks(sessionId: string): Promise<Blob[]> {
    const db = await open();
    const rows = await new Promise<ChunkRow[]>((res, rej) => {
      const req = db.transaction("chunks", "readonly").objectStore("chunks").index("bySession").getAll(sessionId);
      req.onsuccess = () => res(req.result as ChunkRow[]);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return rows.sort((a, b) => a.seq - b.seq).map((r) => r.blob);
  },
  async blob(sessionId: string, mimeType: string): Promise<Blob> {
    return new Blob(await this.chunks(sessionId), { type: mimeType });
  },
  async bytes(sessionId: string): Promise<number> {
    return (await this.chunks(sessionId)).reduce((n, b) => n + b.size, 0);
  },
  async remove(sessionId: string) {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const t = db.transaction(["sessions", "chunks"], "readwrite");
      t.objectStore("sessions").delete(sessionId);
      const idx = t.objectStore("chunks").index("bySession");
      const req = idx.openKeyCursor(sessionId);
      req.onsuccess = () => {
        const c = req.result;
        if (c) { t.objectStore("chunks").delete(c.primaryKey); c.continue(); }
      };
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
    db.close();
  },
  /** 녹음 중 상태로 남아 있는(비정상 종료) 세션을 stopped 로 복구. 길이는 chunk 수로 추정 */
  async recoverOrphans(timesliceMs: number): Promise<RecordingSession[]> {
    const all = await this.list();
    const fixed: RecordingSession[] = [];
    for (const s of all) {
      if (s.state !== "recording") continue;
      const n = (await this.chunks(s.sessionId)).length;
      const r: RecordingSession = {
        ...s, state: "stopped", durationEstimated: true,
        durationSec: Math.max(s.durationSec, (n * timesliceMs) / 1000),
        stoppedAtUtc: s.stoppedAtUtc ?? new Date().toISOString(),
      };
      await this.put(r); fixed.push(r);
    }
    return fixed;
  },
};

export function extForMime(m: string) {
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4")) return "m4a";
  if (m.includes("aac")) return "aac";
  if (m.includes("wav")) return "wav";
  return "bin";
}
export function recordingFilename(s: RecordingSession) {
  const d = new Date(Date.parse(s.startedAtUtc) + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  const base = (s.title || "녹음").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 40);
  return `${stamp}-${base}.${extForMime(s.mimeType)}`;
}
