import type { Meeting, Turn } from "@minutes/shared";
import { dayKey, fmtDateTime, fmtDuration } from "./time";
import { renderMarkdown } from "../components/Markdown";

/** 공유용 파일 이름: 2026-10-15-회의제목.md (파일명에 못 쓰는 문자는 _ 로) */
export function exportFilename(m: Meeting, ext: string) {
  const title = (m.title || "회의").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80);
  return `${dayKey(m.startUtc)}-${title}.${ext}`;
}

/** 회의 메타 헤더 (제목·일시·길이·참석자·화자) */
function metaLines(m: Meeting) {
  const speakers = Object.values(m.speakers).filter(Boolean);
  const lines = [`- 일시: ${fmtDateTime(m.startUtc)}${m.durationSec ? ` (${fmtDuration(m.durationSec)})` : ""}`];
  if (m.attendees.length) lines.push(`- 참석자: ${m.attendees.join(", ")}`);
  else if (speakers.length) lines.push(`- 화자: ${speakers.join(", ")}`);
  return lines;
}

/** 미팅노트를 헤더 포함 마크다운 문서로 */
export function noteMarkdown(m: Meeting, note: string) {
  return `# ${m.title || "회의록"}\n\n${metaLines(m).join("\n")}\n\n${note.trim()}\n`;
}

/** 전사문을 텍스트로 (화자 이름 치환) */
export function transcriptText(m: Meeting, turns: Turn[]) {
  const head = [m.title || "회의록", ...metaLines(m).map((l) => l.replace(/^- /, ""))].join("\n");
  return `${head}\n\n${turns.map((t) => `${m.speakers[t.speaker] ?? t.speaker}: ${t.text}`).join("\n")}\n`;
}

export function downloadText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const PRINT_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; color: #111; line-height: 1.55; font-size: 11pt; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  .meta { color: #555; font-size: 10pt; margin: 0 0 14pt; padding-bottom: 8pt; border-bottom: 1px solid #ccc; }
  /* 렌더러가 제목을 한 단계 내리므로 노트의 ## 는 h3, ### 는 h4 로 온다 */
  h2, h3 { font-size: 14pt; margin: 16pt 0 6pt; break-after: avoid; }
  h4 { font-size: 12pt; margin: 12pt 0 4pt; break-after: avoid; }
  ul, ol { padding-left: 1.4em; margin: 4pt 0; }
  li { margin: 2pt 0; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 10pt; break-inside: avoid; }
  th, td { border: 1px solid #bbb; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 0.9em; background: #f4f4f4; padding: 0 3px; }
  a { color: inherit; text-decoration: none; }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * 노트를 인쇄용 문서로 렌더해 브라우저 인쇄 대화상자를 연다 (대상에서 "PDF로 저장" 선택).
 * 서버·외부 라이브러리 없이 동작하며, 숨은 iframe 을 써서 팝업 차단에 걸리지 않는다.
 */
export function printNote(m: Meeting, note: string) {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(exportFilename(m, "pdf").replace(/\.pdf$/, ""))}</title><style>${PRINT_CSS}</style></head>
<body><h1>${esc(m.title || "회의록")}</h1><p class="meta">${metaLines(m).map((l) => esc(l.replace(/^- /, ""))).join(" · ")}</p>${renderMarkdown(note)}</body></html>`;
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open(); doc.write(html); doc.close();
  const win = frame.contentWindow!;
  const cleanup = () => setTimeout(() => frame.remove(), 500);
  win.addEventListener("afterprint", cleanup, { once: true });
  // 이미지/폰트 로드 뒤 인쇄. afterprint 미지원 브라우저를 위해 안전장치로 1분 뒤 제거
  setTimeout(() => { win.focus(); win.print(); setTimeout(() => frame.isConnected && frame.remove(), 60_000); }, 100);
}
