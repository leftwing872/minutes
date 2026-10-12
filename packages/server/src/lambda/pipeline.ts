import { DynamoMeetingStore } from "../store/dynamo.js";
import { stepStartTranscribe, stepCheckTranscribe, stepRefinePrepare, stepRefineWindow, stepRefineMerge, stepSummarize, markFailed } from "../pipeline/steps.js";

const store = new DynamoMeetingStore();

type Event =
  | { step: "startTranscribe"; meetingId: string }
  | { step: "checkTranscribe"; meetingId: string }
  | { step: "refinePrepare"; meetingId: string }
  | { step: "refineWindow"; meetingId: string; index: number }
  | { step: "refineMerge"; meetingId: string; count: number }
  | { step: "summarize"; meetingId: string }
  | { step: "fail"; meetingId: string; error?: { Cause?: string; Error?: string } };

/** Step Functions 가 호출하는 단일 핸들러. `step` 으로 분기 */
export async function handler(e: Event) {
  switch (e.step) {
    case "startTranscribe": return stepStartTranscribe(store, e.meetingId);
    case "checkTranscribe": return stepCheckTranscribe(store, e.meetingId);
    case "refinePrepare": return stepRefinePrepare(store, e.meetingId);
    case "refineWindow": return stepRefineWindow(store, e.meetingId, e.index);
    case "refineMerge": return stepRefineMerge(store, e.meetingId, e.count);
    case "summarize": return stepSummarize(store, e.meetingId);
    case "fail": {
      let msg = e.error?.Error ?? "알 수 없는 오류";
      try { const c = JSON.parse(e.error?.Cause ?? "{}"); if (c.errorMessage) msg = c.errorMessage; } catch { if (e.error?.Cause) msg = e.error.Cause.slice(0, 300); }
      return markFailed(store, e.meetingId, msg);
    }
  }
}
