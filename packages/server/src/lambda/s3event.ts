import type { S3Event } from "aws-lambda";
import { DynamoMeetingStore } from "../store/dynamo.js";
import { SfnPipelineStarter } from "../pipeline/sfn.js";

const store = new DynamoMeetingStore();
const starter = new SfnPipelineStarter(process.env.STATE_MACHINE_ARN!);

/** meetings/{id}/audio/* 객체 생성 → 파이프라인 시작 (클라이언트 complete 호출과 경쟁하면 한쪽만 진행) */
export async function handler(event: S3Event) {
  for (const rec of event.Records) {
    const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, " "));
    const m = key.match(/^meetings\/([^/]+)\/audio\//);
    if (!m) continue;
    const id = m[1]!;
    const meeting = await store.get(id);
    if (!meeting || meeting.status !== "PENDING_UPLOAD") continue;
    try {
      await store.update(id, { status: "UPLOADED", statusMessage: null, bytes: rec.s3.object.size });
      await starter.start(id);
    } catch (e) { console.error(`[s3event] ${id}`, e); }
  }
}
