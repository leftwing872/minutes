import fs from "node:fs/promises";
import path from "node:path";
import type { Meeting, Turn, Turns } from "@minutes/shared";
import type { MeetingStore } from "../store/types.js";
import { keys, putJson, putText, getJson, headObject, getBytes } from "../aws.js";
import { startTranscribeJob, isTranscribeJobDone, loadTranscribeTurns } from "./transcribe.js";
import { qwenEnabled, transcribeWithQwen, type QwenChunk } from "./qwen.js";
import { refineWindow, windowize } from "./refine.js";
import { summarize, notePreview } from "./summarize.js";
import { probe, withTempDir } from "../audio.js";

/**
 * 파이프라인 단계. 로컬 러너와 Step Functions Lambda 가 공유한다.
 * 각 단계는 멱등에 가깝게 작성 (재시도 안전).
 */
const audioKey = (m: Meeting) => keys.audio(m.meetingId, m.originalFilename);
const log = (id: string, s: string) => console.log(`[pipeline] ${id} ${s}`);

async function must(store: MeetingStore, id: string): Promise<Meeting> {
  const m = await store.get(id);
  if (!m) throw new Error(`회의 ${id} 가 없습니다.`);
  return m;
}

/** UPLOADED → 메타데이터 보완 + Transcribe 시작 → TRANSCRIBING */
export async function stepStartTranscribe(store: MeetingStore, id: string) {
  const m = await must(store, id);
  const head = await headObject(audioKey(m));
  if (!head) throw new Error("업로드된 오디오 파일을 찾을 수 없습니다.");
  const patch: Parameters<MeetingStore["update"]>[1] = { bytes: head.bytes };
  if (m.durationSec == null || m.timeSource === "upload") {
    const p = await probeFromS3(m);
    if (p.durationSec != null) patch.durationSec = p.durationSec;
    if (m.timeSource === "upload") {
      if (p.creationTime) { patch.startUtc = p.creationTime; patch.timeSource = "file"; }
      else if (p.durationSec != null) patch.startUtc = new Date(Date.parse(m.createdAt) - p.durationSec * 1000).toISOString();
    }
  }
  const job = await startTranscribeJob(id, audioKey(m), m.contentType);
  await store.update(id, { ...patch, status: "TRANSCRIBING", statusMessage: null, transcribeJob: job });
  log(id, `Transcribe 시작 (${job})`);
  return { jobName: job };
}

/** Transcribe 완료 확인. 완료 시 turns.json 저장 → REFINING. 반환: done 여부 */
export async function stepCheckTranscribe(store: MeetingStore, id: string): Promise<{ done: boolean }> {
  const job = await store.getTranscribeJob(id);
  if (!job) throw new Error("Transcribe 작업 정보가 없습니다.");
  if (!(await isTranscribeJobDone(job))) return { done: false };
  const raw = await loadTranscribeTurns(id);
  if (!raw.length) throw new Error("전사 결과가 비어 있습니다. 음성이 인식되지 않았습니다.");
  await putJson(keys.turns(id), { raw, refined: null } satisfies Turns);
  await store.update(id, { status: "REFINING", statusMessage: null });
  log(id, `Transcribe 완료 (${raw.length} turns)`);
  return { done: true };
}

/** Qwen3-ASR 2차 전사 + 보정 창 분할. 반환: 창 인덱스 목록 (비활성이면 []) */
export async function stepRefinePrepare(store: MeetingStore, id: string): Promise<{ windows: number[] }> {
  const m = await must(store, id);
  if (!qwenEnabled()) {
    log(id, "QWEN_ASR_URL 미설정 — 정밀 전사 건너뜀");
    await store.update(id, { status: "SUMMARIZING", statusMessage: null });
    return { windows: [] };
  }
  let qwen = await getJson<QwenChunk[]>(keys.qwen(id));
  if (!qwen) {
    log(id, "Qwen3-ASR 정밀 전사");
    qwen = await transcribeWithQwen(id, audioKey(m));
    await putJson(keys.qwen(id), qwen);
  }
  const turns = (await getJson<Turns>(keys.turns(id)))!;
  const windows = windowize(turns.raw, 7000);
  await putJson(keys.windows(id), windows);
  return { windows: windows.map((_, i) => i) };
}

/** 창 하나 보정 → refine/window-i.json */
export async function stepRefineWindow(store: MeetingStore, id: string, index: number) {
  const m = await must(store, id);
  const windows = (await getJson<Turn[][]>(keys.windows(id)))!;
  const qwen = (await getJson<QwenChunk[]>(keys.qwen(id)))!;
  const w = windows[index];
  if (!w) throw new Error(`창 ${index} 가 없습니다.`);
  const refined = await refineWindow(w, qwen, m.attendees);
  await putJson(keys.refineWindow(id, index), refined);
  return { index };
}

/** 창 병합 → turns.refined → SUMMARIZING */
export async function stepRefineMerge(store: MeetingStore, id: string, count: number) {
  const turns = (await getJson<Turns>(keys.turns(id)))!;
  const parts: Turn[] = [];
  for (let i = 0; i < count; i++) parts.push(...((await getJson<Turn[]>(keys.refineWindow(id, i))) ?? []));
  turns.refined = parts;
  await putJson(keys.turns(id), turns);
  await store.update(id, { hasRefined: true, status: "SUMMARIZING", statusMessage: null });
  log(id, `보정 완료 (${parts.length} turns)`);
}

/** 노트 (재)생성 → DONE */
export async function stepSummarize(store: MeetingStore, id: string) {
  const m = await must(store, id);
  const turns = (await getJson<Turns>(keys.turns(id)))!;
  const src: Turn[] = turns.refined ?? turns.raw;
  log(id, "미팅노트 작성");
  const r = await summarize(src, {
    title: m.title, attendees: m.attendees,
    startLocal: new Intl.DateTimeFormat("ko-KR", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Seoul" }).format(new Date(m.startUtc)),
    durationLabel: m.durationSec ? `${Math.round(m.durationSec / 60)}분` : "길이 미상",
  });
  await putText(keys.note(id), r.note, "text/markdown; charset=utf-8");
  const speakers = Object.keys(m.speakers).length ? m.speakers : r.speakers;
  await store.update(id, {
    ...(r.title && !m.title ? { title: r.title } : {}),
    notePreview: notePreview(r.note), noteEditedAt: null, speakers, status: "DONE", statusMessage: null,
  });
  log(id, "완료");
}

export async function markFailed(store: MeetingStore, id: string, message: string) {
  console.error(`[pipeline] ${id} 실패:`, message);
  await store.update(id, { status: "FAILED", statusMessage: message });
}

async function probeFromS3(m: Meeting) {
  const bytes = await getBytes(audioKey(m));
  return withTempDir(async (dir) => {
    const f = path.join(dir, `a${path.extname(m.originalFilename) || ".bin"}`);
    await fs.writeFile(f, bytes);
    return probe(f);
  });
}
