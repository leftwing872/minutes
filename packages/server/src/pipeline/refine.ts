import type { Turn } from "@minutes/shared";
import { converse } from "../aws.js";
import type { QwenChunk } from "./qwen.js";

/**
 * Transcribe(화자 분리·타임스탬프 정확) + Qwen3-ASR(단어 정확도 높음) 두 전사문을 대조해 보정.
 * 창(window) 하나를 LLM에 보내 턴 수·순서·화자·시각은 유지하고 텍스트만 고친다.
 */
export async function refineWindow(turns: Turn[], qwen: QwenChunk[], attendees: string[]): Promise<Turn[]> {
  const startSec = (turns[0]?.startMs ?? 0) / 1000;
  const endSec = (turns[turns.length - 1]?.endMs ?? 0) / 1000;
  const reference = qwen
    .filter((c) => c.offsetSec < endSec + 30 && c.offsetSec + c.durationSec > startSec - 30)
    .map((c) => `[${fmt(c.offsetSec)}~${fmt(c.offsetSec + c.durationSec)}]\n${c.text}`)
    .join("\n\n");
  const system = `당신은 한국어 회의 전사문 교정 전문가입니다.
입력 A는 Amazon Transcribe 결과(화자 구분과 시각은 정확하지만 단어 오인식이 있음), 입력 B는 Qwen3-ASR 결과(단어 정확도가 높지만 화자 구분 없음)입니다.
A의 각 턴을 B와 대조해 텍스트만 교정하세요. 규칙:
- 턴의 개수, 순서, speaker, startMs, endMs 는 절대 바꾸지 않습니다.
- 오인식된 단어·고유명사·숫자·영어 용어를 B 기준으로 고치고, 자연스러운 띄어쓰기와 문장부호를 넣습니다.
- 두 전사문이 모두 불확실하면 A를 유지합니다. 내용을 요약·삭제·추가하지 않습니다.
- 출력은 JSON 배열만. 각 원소는 {"i":<입력 인덱스>,"text":"<교정 텍스트>"}. 다른 설명은 쓰지 않습니다.`;
  const user = `참석자 (고유명사 참고): ${attendees.join(", ") || "(없음)"}

## 입력 A (Transcribe, 인덱스 포함)
${turns.map((t, i) => `${i}\t${t.speaker}\t${fmt(t.startMs / 1000)}\t${t.text}`).join("\n")}

## 입력 B (Qwen3-ASR)
${reference || "(해당 구간 없음)"}

JSON 배열:`;
  const text = await converse(system, user, { maxTokens: 12000, temperature: 0 });
  const arr = parseJsonArray<{ i: number; text: string }>(text);
  const byIdx = new Map(arr.map((a) => [a.i, a.text]));
  return turns.map((t, i) => ({ ...t, text: (byIdx.get(i) ?? t.text).trim() || t.text }));
}

export function windowize(turns: Turn[], maxChars: number): Turn[][] {
  const out: Turn[][] = [];
  let cur: Turn[] = [], n = 0;
  for (const t of turns) {
    if (cur.length && n + t.text.length > maxChars) { out.push(cur); cur = []; n = 0; }
    cur.push(t); n += t.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function parseJsonArray<T>(text: string): T[] {
  const s = text.indexOf("["), e = text.lastIndexOf("]");
  if (s < 0 || e < 0) throw new Error("모델 응답에서 JSON 배열을 찾을 수 없습니다.");
  return JSON.parse(text.slice(s, e + 1)) as T[];
}

const fmt = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
};
