import { STATUS_LABEL, type MeetingStatus } from "@minutes/shared";

const CLS: Record<MeetingStatus, string> = {
  PENDING_UPLOAD: "pending", UPLOADED: "pending", TRANSCRIBING: "working", REFINING: "working",
  SUMMARIZING: "working", DONE: "done", FAILED: "failed",
};

export function Badge({ status, compact }: { status: MeetingStatus; compact?: boolean }) {
  const text = STATUS_LABEL[status], cls = CLS[status];
  if (compact)
    return <span className={`badge ${cls} compact`} title={text}>{status === "DONE" ? "✓" : status === "FAILED" ? "!" : "···"}</span>;
  return <span className={`badge ${cls}`}>{text}</span>;
}
