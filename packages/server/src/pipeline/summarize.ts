import type { Turn } from "@minutes/shared";
import { converse } from "../aws.js";

export type Summary = { title: string | null; note: string; speakers: Record<string, string> };

/** 보정된 전사문 → 미팅노트(markdown) + 제목(없을 때) + 화자 이름 추정 */
export async function summarize(
  turns: Turn[],
  opts: { title: string; attendees: string[]; startLocal: string; durationLabel: string },
): Promise<Summary> {
  const system = `당신은 회의록 작성 전문가입니다. 전사문을 읽고 한국어 미팅노트를 작성합니다.
출력 형식(태그 밖에는 아무것도 쓰지 않습니다):
<title>회의 제목 (제목이 이미 주어졌으면 그대로)</title>
<speakers>{"spk_0":"이름 또는 역할", ...}</speakers>
<note>
## 요약
(3~5문장)

## 논의 내용
### (주제 1)
- ...
### (주제 2)
- ...

## 결정 사항
- ...

## 액션 아이템
| 담당 | 할 일 | 기한 |
|---|---|---|
| ... | ... | ... |

## 다음 단계 / 미결 사항
- ...
</note>

규칙:
- 전사문에 있는 내용만 쓰고, 없는 내용을 추측해 넣지 않습니다. 해당 없는 섹션은 "- 없음"으로 둡니다.
- 화자 이름은 전사문에서 자기소개·호칭·참석자 목록을 근거로 추정하고, 근거가 없으면 "화자 1", "화자 2"처럼 둡니다.
- 숫자·날짜·고유명사는 원문을 유지합니다. 간결하되 결정과 액션은 빠짐없이 적습니다.`;
  const body = turns.map((t) => `[${ms(t.startMs)}] ${t.speaker}: ${t.text}`).join("\n");
  const user = `회의 제목: ${opts.title || "(없음 — 내용으로 생성)"}
회의 일시: ${opts.startLocal} (${opts.durationLabel})
참석자: ${opts.attendees.join(", ") || "(미입력)"}

## 전사문
${body}`;
  const text = await converse(system, user, { maxTokens: 8000, temperature: 0.3 });
  const title = tag(text, "title");
  const note = tag(text, "note") ?? text.trim();
  let speakers: Record<string, string> = {};
  try { speakers = JSON.parse(tag(text, "speakers") ?? "{}"); } catch { /* ignore */ }
  return { title: title && title !== opts.title ? title : null, note, speakers };
}

function tag(text: string, name: string): string | null {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1]!.trim() : null;
}

const ms = (v: number) => {
  const s = Math.floor(v / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
};

/** 목록 미리보기: 요약 섹션 첫 문장들 */
export function notePreview(note: string, max = 160): string {
  const lines = note.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("|"));
  const text = lines.join(" ").replace(/^[-*]\s*/g, "").replace(/\s+/g, " ");
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
