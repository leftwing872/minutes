import {
  StartTranscriptionJobCommand, GetTranscriptionJobCommand, type LanguageCode,
} from "@aws-sdk/client-transcribe";
import type { Turn } from "@minutes/shared";
import { transcribe, s3Uri, keys, getJson } from "../aws.js";
import { config } from "../config.js";

export async function startTranscribeJob(meetingId: string, audioKey: string, contentType: string) {
  const jobName = `minutes-${meetingId}-${Date.now()}`;
  const lang = config.transcribe.language;
  const fmt = mediaFormat(audioKey, contentType);
  await transcribe.send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      Media: { MediaFileUri: s3Uri(audioKey) },
      ...(fmt ? { MediaFormat: fmt } : {}),
      OutputBucketName: config.bucket,
      OutputKey: keys.transcribeOut(meetingId),
      ...(lang === "auto"
        ? { IdentifyLanguage: true, LanguageOptions: ["ko-KR", "en-US"] as LanguageCode[] }
        : { LanguageCode: lang as LanguageCode }),
      Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: config.transcribe.maxSpeakers },
    }),
  );
  return jobName;
}

/** 작업 상태 확인. 완료면 true, 진행 중이면 false, 실패 시 throw. */
export async function isTranscribeJobDone(jobName: string): Promise<boolean> {
  const r = await transcribe.send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }));
  const j = r.TranscriptionJob!;
  if (j.TranscriptionJobStatus === "COMPLETED") return true;
  if (j.TranscriptionJobStatus === "FAILED") throw new Error(`Transcribe 실패: ${j.FailureReason ?? "unknown"}`);
  return false;
}

function mediaFormat(key: string, contentType: string) {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = {
    mp3: "mp3", mp4: "mp4", m4a: "mp4", wav: "wav", flac: "flac", ogg: "ogg", oga: "ogg", opus: "ogg",
    webm: "webm", amr: "amr",
  };
  if (byExt[ext]) return byExt[ext] as any;
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("mp4") || contentType.includes("m4a") || contentType.includes("aac")) return "mp4";
  if (contentType.includes("mpeg")) return "mp3";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("ogg")) return "ogg";
  return undefined;
}

type TranscribeJson = {
  results: {
    transcripts: { transcript: string }[];
    items: {
      type: "pronunciation" | "punctuation";
      start_time?: string; end_time?: string; speaker_label?: string;
      alternatives: { content: string }[];
    }[];
    audio_segments?: { speaker_label?: string; start_time: string; end_time: string; transcript: string }[];
    speaker_labels?: { segments: { speaker_label: string; start_time: string; end_time: string; items: { start_time: string; speaker_label: string }[] }[] };
  };
};

/** Transcribe 출력 JSON → 화자별 turn 배열 */
export async function loadTranscribeTurns(meetingId: string): Promise<Turn[]> {
  const j = await getJson<TranscribeJson>(keys.transcribeOut(meetingId));
  if (!j) throw new Error("Transcribe 결과 파일이 없습니다.");
  return toTurns(j);
}

export function toTurns(j: TranscribeJson): Turn[] {
  const res = j.results;
  // 1) 최신 포맷: audio_segments에 화자 라벨 포함
  if (res.audio_segments?.length && res.audio_segments.some((s) => s.speaker_label)) {
    return mergeAdjacent(
      res.audio_segments.map((s) => ({
        speaker: s.speaker_label ?? "spk_0",
        text: s.transcript.trim(),
        startMs: sec(s.start_time),
        endMs: sec(s.end_time),
      })),
    );
  }
  // 2) items 기반: 각 단어의 speaker_label(또는 speaker_labels.segments 매핑)로 묶기
  const labelByStart = new Map<string, string>();
  for (const seg of res.speaker_labels?.segments ?? [])
    for (const it of seg.items) labelByStart.set(it.start_time, it.speaker_label);

  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const it of res.items) {
    const word = it.alternatives[0]?.content ?? "";
    if (it.type === "punctuation") {
      if (cur) cur.text += word;
      continue;
    }
    const spk = it.speaker_label ?? labelByStart.get(it.start_time ?? "") ?? "spk_0";
    const s = sec(it.start_time ?? "0"), e = sec(it.end_time ?? it.start_time ?? "0");
    if (!cur || cur.speaker !== spk) {
      cur = { speaker: spk, text: word, startMs: s, endMs: e };
      turns.push(cur);
    } else {
      cur.text += (needsSpace(cur.text, word) ? " " : "") + word;
      cur.endMs = e;
    }
  }
  return turns.filter((t) => t.text.trim());
}

function needsSpace(prev: string, word: string) {
  return prev.length > 0 && !/^[,.!?;:]/.test(word);
}
const sec = (s: string) => Math.round(Number(s) * 1000);

function mergeAdjacent(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.speaker === t.speaker && t.startMs - last.endMs < 1500) {
      last.text = `${last.text} ${t.text}`.trim();
      last.endMs = t.endMs;
    } else out.push({ ...t });
  }
  return out.filter((t) => t.text);
}
