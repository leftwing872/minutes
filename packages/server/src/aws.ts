import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { TranscribeClient } from "@aws-sdk/client-transcribe";
import { BedrockRuntimeClient, ConverseCommand, type Message } from "@aws-sdk/client-bedrock-runtime";
import { config } from "./config.js";

export const s3 = new S3Client({ region: config.region });
export const transcribe = new TranscribeClient({ region: config.region });
export const bedrock = new BedrockRuntimeClient({ region: config.region });

/** S3 키 레이아웃 (배포 시에도 동일하게 사용) */
export const keys = {
  audio: (meetingId: string, filename: string) => `meetings/${meetingId}/audio/${safeName(filename)}`,
  transcribeOut: (meetingId: string) => `meetings/${meetingId}/transcribe.json`,
  turns: (meetingId: string) => `meetings/${meetingId}/turns.json`,
  qwen: (meetingId: string) => `meetings/${meetingId}/qwen.json`,
  note: (meetingId: string) => `meetings/${meetingId}/note.md`,
  windows: (meetingId: string) => `meetings/${meetingId}/refine/windows.json`,
  refineWindow: (meetingId: string, i: number) => `meetings/${meetingId}/refine/window-${String(i).padStart(4, "0")}.json`,
  prefix: (meetingId: string) => `meetings/${meetingId}/`,
};

function safeName(name: string) {
  return name.replace(/[^\w.\-가-힣 ]+/g, "_").slice(-120) || "audio";
}

export async function presignPut(key: string, contentType: string) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }),
    { expiresIn: 60 * 60 },
  );
}

export async function presignGet(key: string, filename?: string) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ResponseContentDisposition: filename ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` : undefined,
    }),
    { expiresIn: 60 * 10 },
  );
}

export async function headObject(key: string) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return { bytes: r.ContentLength ?? 0, contentType: r.ContentType ?? "" };
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return null;
    throw e;
  }
}

export async function putText(key: string, body: string, contentType = "text/plain; charset=utf-8") {
  await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function putJson(key: string, value: unknown) {
  await putText(key, JSON.stringify(value), "application/json");
}

export async function getText(key: string): Promise<string | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    return (await r.Body?.transformToString("utf-8")) ?? "";
  } catch (e: any) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function getJson<T>(key: string): Promise<T | null> {
  const t = await getText(key);
  return t === null ? null : (JSON.parse(t) as T);
}

export async function getBytes(key: string): Promise<Uint8Array> {
  const r = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  return await r.Body!.transformToByteArray();
}

export async function deletePrefix(prefix: string) {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }));
  const objs = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
  if (objs.length) await s3.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: objs } }));
}

export function s3Uri(key: string) {
  return `s3://${config.bucket}/${key}`;
}

/** Bedrock Converse 호출 (텍스트) */
export async function converse(system: string, user: string, opts: { maxTokens?: number; temperature?: number } = {}) {
  const messages: Message[] = [{ role: "user", content: [{ text: user }] }];
  const r = await bedrock.send(
    new ConverseCommand({
      modelId: config.bedrock.modelId,
      system: [{ text: system }],
      messages,
      inferenceConfig: { maxTokens: opts.maxTokens ?? 8000, temperature: opts.temperature ?? 0.2 },
    }),
  );
  const text = r.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
  if (r.stopReason === "max_tokens") throw new Error("모델 출력이 잘렸습니다 (max_tokens)");
  return text;
}
