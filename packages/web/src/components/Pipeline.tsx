import type { MeetingStatus } from "@minutes/shared";

const STEPS = [
  { key: "upload", label: "업로드", statuses: ["PENDING_UPLOAD", "UPLOADED"], hint: "녹음 파일을 서버로 보내는 중입니다." },
  { key: "transcribe", label: "음성 인식", statuses: ["TRANSCRIBING"], hint: "Amazon Transcribe가 화자를 구분하며 전사하고 있습니다." },
  { key: "refine", label: "정밀 전사", statuses: ["REFINING"], hint: "Qwen3-ASR로 한 번 더 전사해 단어 정확도를 높이고 있습니다." },
  { key: "note", label: "보정·노트 작성", statuses: ["SUMMARIZING"], hint: "두 전사문을 대조해 보정하고 미팅노트를 작성하고 있습니다." },
];

export function Pipeline({ status }: { status: MeetingStatus }) {
  if (status === "DONE") return null;
  const failed = status === "FAILED";
  const idx = failed ? -1 : STEPS.findIndex((s) => s.statuses.includes(status));
  return (
    <div className={`pipe ${failed ? "failed" : ""}`}>
      <div className="pipe-steps">
        {STEPS.map((s, i) => {
          const cls = failed ? "halted" : i < idx ? "done" : i === idx ? "active" : "todo";
          return (
            <div key={s.key} className={`pipe-step ${cls}`}>
              <span className="pipe-dot" aria-hidden="true">{cls === "done" ? "✓" : ""}</span>
              <span className="pipe-label">{s.label}</span>
            </div>
          );
        })}
      </div>
      <p className="pipe-hint muted small">{failed ? "처리가 중단되었습니다." : STEPS[idx]?.hint}</p>
    </div>
  );
}
