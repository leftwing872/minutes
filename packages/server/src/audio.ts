import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minutes-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export type Probe = { durationSec: number | null; creationTime: string | null };

/** ffprobe로 길이와 (있다면) 파일 내부 녹음 시각을 읽는다. */
export async function probe(file: string): Promise<Probe> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
    ]);
    const j = JSON.parse(stdout);
    const dur = Number(j.format?.duration);
    const tags = { ...(j.format?.tags ?? {}), ...(j.streams?.[0]?.tags ?? {}) };
    const ct = tags.creation_time ?? tags["com.apple.quicktime.creationdate"] ?? tags.date ?? null;
    let creationTime: string | null = null;
    if (ct) {
      const t = Date.parse(ct);
      if (!Number.isNaN(t)) creationTime = new Date(t).toISOString();
    }
    return { durationSec: Number.isFinite(dur) ? dur : null, creationTime };
  } catch {
    return { durationSec: null, creationTime: null };
  }
}

/** 16kHz mono WAV 조각으로 분할. 반환: [{file, offsetSec}] */
export async function splitToWavChunks(input: string, outDir: string, chunkSec: number) {
  const pattern = path.join(outDir, "chunk-%04d.wav");
  await run("ffmpeg", [
    "-v", "error", "-y", "-i", input, "-ac", "1", "-ar", "16000", "-vn",
    "-f", "segment", "-segment_time", String(chunkSec), "-reset_timestamps", "1", pattern,
  ]);
  const files = (await fs.readdir(outDir)).filter((f) => f.startsWith("chunk-")).sort();
  return files.map((f, i) => ({ file: path.join(outDir, f), offsetSec: i * chunkSec }));
}

export function hasFfmpeg(): Promise<boolean> {
  return run("ffmpeg", ["-version"]).then(() => true, () => false);
}
