import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { getBytes, keys } from "../aws.js";
import { splitToWavChunks, withTempDir } from "../audio.js";

export type QwenChunk = { offsetSec: number; durationSec: number; text: string };

export const qwenEnabled = () => Boolean(config.qwen.url);

/**
 * Qwen3-ASR 로 2차 전사. OpenAI 호환 `/v1/audio/transcriptions` (vLLM 등)를 사용한다.
 * 오디오를 chunkSec 단위 16k mono WAV로 잘라 순서대로 보낸다.
 */
export async function transcribeWithQwen(meetingId: string, audioKey: string): Promise<QwenChunk[]> {
  const bytes = await getBytes(audioKey);
  return withTempDir(async (dir) => {
    const input = path.join(dir, `input${path.extname(audioKey) || ".bin"}`);
    await fs.writeFile(input, bytes);
    const chunks = await splitToWavChunks(input, dir, config.qwen.chunkSec);
    const out: QwenChunk[] = [];
    for (const c of chunks) {
      const text = await callQwen(c.file);
      out.push({ offsetSec: c.offsetSec, durationSec: config.qwen.chunkSec, text });
    }
    return out;
  });
}

async function callQwen(wavFile: string): Promise<string> {
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
  const j = (await res.json()) as { text?: string };
  return (j.text ?? "").trim();
}

export const qwenKey = keys.qwen;
