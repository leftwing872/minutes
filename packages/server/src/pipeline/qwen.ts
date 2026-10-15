import fs from "node:fs/promises";
import path from "node:path";
import { SageMakerRuntimeClient, InvokeEndpointAsyncCommand } from "@aws-sdk/client-sagemaker-runtime";
import { config } from "../config.js";
import { getBytes, getJson, putJson, putBytes, headObject, getText, keys, s3Uri } from "../aws.js";
import { splitToWavChunks, withTempDir } from "../audio.js";

export type QwenChunk = { offsetSec: number; durationSec: number; text: string };
/** SageMaker 비동기 호출 1건 (오디오 조각 하나) */
export type QwenJob = { index: number; offsetSec: number; durationSec: number; outputKey: string; failureKey: string; attempts?: number };
/** 조각 하나당 최대 시도 횟수 (엔드포인트 인스턴스 교체 등 일시 장애 대비) */
const MAX_ATTEMPTS = 3;

export type QwenMode = "off" | "http" | "sagemaker";
export const qwenMode = (): QwenMode => config.qwen.mode;
export const qwenEnabled = () => qwenMode() !== "off";

const s3KeyFromUri = (uri: string) => uri.replace(/^s3:\/\/[^/]+\//, "");

/**
 * 2차 전사 준비. 오디오를 16k mono WAV 조각으로 나눈 뒤
 *  - http:      OpenAI 호환 엔드포인트를 즉시 순서대로 호출해 qwen.json 저장 → pending=false
 *  - sagemaker: 조각을 S3 에 올리고 InvokeEndpointAsync 로 큐에 넣음 → jobs.json 저장, pending=true
 */
export async function prepareQwen(meetingId: string, audioKey: string, attendees: string[]): Promise<{ pending: boolean }> {
  if (await getJson<QwenChunk[]>(keys.qwen(meetingId))) return { pending: false }; // 이미 완료
  const bytes = await getBytes(audioKey);
  return withTempDir(async (dir) => {
    const input = path.join(dir, `input${path.extname(audioKey) || ".bin"}`);
    await fs.writeFile(input, bytes);
    const chunks = await splitToWavChunks(input, dir, config.qwen.chunkSec);
    const context = attendees.join(", ");

    if (qwenMode() === "http") {
      const out: QwenChunk[] = [];
      for (const c of chunks) out.push({ offsetSec: c.offsetSec, durationSec: config.qwen.chunkSec, text: await callHttp(c.file) });
      await putJson(keys.qwen(meetingId), out);
      return { pending: false };
    }

    const jobs: QwenJob[] = [];
    for (const [i, c] of chunks.entries()) {
      const inKey = keys.qwenIn(meetingId, i);
      await putBytes(inKey, await fs.readFile(c.file), "audio/wav");
      jobs.push(await enqueue(meetingId, { index: i, offsetSec: c.offsetSec, durationSec: config.qwen.chunkSec }, context));
    }
    await putJson(keys.qwenJobs(meetingId), jobs);
    return { pending: true };
  });
}

/** 조각 하나를 비동기 엔드포인트 큐에 넣고 결과/실패 위치를 기록한 job 을 돌려준다 */
async function enqueue(meetingId: string, base: Pick<QwenJob, "index" | "offsetSec" | "durationSec">, context: string, attempts = 1): Promise<QwenJob> {
  const sm = new SageMakerRuntimeClient({ region: config.region });
  const r = await sm.send(new InvokeEndpointAsyncCommand({
    EndpointName: config.qwen.endpointName,
    InputLocation: s3Uri(keys.qwenIn(meetingId, base.index)),
    ContentType: "audio/wav",
    Accept: "application/json",
    InvocationTimeoutSeconds: 3600,
    CustomAttributes: context ? `context=${encodeURIComponent(context)}` : undefined,
  }));
  return { ...base, outputKey: s3KeyFromUri(r.OutputLocation!), failureKey: s3KeyFromUri(r.FailureLocation ?? ""), attempts };
}

/**
 * sagemaker 모드: 모든 조각 결과가 나왔으면 qwen.json 으로 합치고 true.
 * 모든 조각을 매번 훑어서, 실패한 조각은 MAX_ATTEMPTS 까지 같은 입력으로 다시 큐에 넣는다
 * (SageMaker 가 인스턴스를 교체하는 동안 처리 중이던 요청이 "could not get a response" 로 실패하는 일시 장애 대비).
 * 한도를 넘긴 조각이 있으면 throw.
 */
export async function checkQwen(meetingId: string, attendees: string[] = []): Promise<boolean> {
  if (await getJson<QwenChunk[]>(keys.qwen(meetingId))) return true;
  const jobs = await getJson<QwenJob[]>(keys.qwenJobs(meetingId));
  if (!jobs) throw new Error("Qwen 작업 정보가 없습니다.");
  const out: QwenChunk[] = [];
  let pending = 0;
  let requeued = false;
  for (const [i, j] of jobs.entries()) {
    const res = await getText(j.outputKey);
    if (res === null) {
      pending++;
      if (!j.failureKey || !(await headObject(j.failureKey))) continue; // 아직 처리 중
      const reason = ((await getText(j.failureKey)) ?? "").slice(0, 300);
      const attempts = j.attempts ?? 1;
      if (attempts >= MAX_ATTEMPTS) throw new Error(`Qwen3-ASR 실패 (조각 ${j.index}, ${attempts}회 시도): ${reason}`);
      console.warn(`[qwen] ${meetingId} 조각 ${j.index} 실패 → 재시도 ${attempts + 1}/${MAX_ATTEMPTS}: ${reason}`);
      jobs[i] = await enqueue(meetingId, j, attendees.join(", "), attempts + 1);
      requeued = true;
      continue;
    }
    const parsed = JSON.parse(res) as { text?: string; error?: string };
    if (parsed.error) throw new Error(`Qwen3-ASR 오류 (조각 ${j.index}): ${parsed.error.slice(0, 300)}`);
    out.push({ offsetSec: j.offsetSec, durationSec: j.durationSec, text: (parsed.text ?? "").trim() });
  }
  if (requeued) await putJson(keys.qwenJobs(meetingId), jobs);
  if (pending > 0) return false;
  await putJson(keys.qwen(meetingId), out);
  return true;
}

async function callHttp(wavFile: string): Promise<string> {
  const url = config.qwen.url.replace(/\/+$/, "");
  const endpoint = url.endsWith("/audio/transcriptions") ? url : `${url}/v1/audio/transcriptions`;
  const form = new FormData();
  form.append("model", config.qwen.model);
  form.append("response_format", "json");
  form.append("file", new Blob([await fs.readFile(wavFile)], { type: "audio/wav" }), path.basename(wavFile));
  const headers: Record<string, string> = {};
  if (config.qwen.apiKey) headers.Authorization = `Bearer ${config.qwen.apiKey}`;
  const res = await fetch(endpoint, { method: "POST", body: form, headers });
  if (!res.ok) throw new Error(`Qwen3-ASR 호출 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (((await res.json()) as { text?: string }).text ?? "").trim();
}
