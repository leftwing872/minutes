/**
 * 업로드 파일에서 녹음 시각/길이 읽기.
 * - 길이: <audio> 엘리먼트 메타데이터 (서버에서도 ffprobe 로 재확인)
 * - 녹음 시각: MP4/M4A 의 mvhd creation_time (아이폰 음성 메모 등). 없으면 null.
 */
export type FileMeta = { durationSec: number | null; recordedAtUtc: string | null };

export async function readFileMeta(file: File): Promise<FileMeta> {
  const [durationSec, recordedAtUtc] = await Promise.all([readDuration(file), readMp4CreationTime(file)]);
  return { durationSec, recordedAtUtc };
}

function readDuration(file: File): Promise<number | null> {
  return new Promise((res) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("audio");
    a.preload = "metadata";
    const done = (v: number | null) => { URL.revokeObjectURL(url); res(v); };
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    a.src = url;
  });
}

/** MP4 컨테이너의 moov/mvhd creation_time (1904 epoch). 앞부분 ~2MB 와 뒷부분 2MB 를 훑는다. */
async function readMp4CreationTime(file: File): Promise<string | null> {
  if (!/\.(m4a|mp4|mov|aac)$/i.test(file.name) && !file.type.includes("mp4")) return null;
  try {
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer());
    let t = findMvhd(head);
    if (t == null && file.size > 2 * 1024 * 1024) {
      const tail = new Uint8Array(await file.slice(file.size - 2 * 1024 * 1024).arrayBuffer());
      t = findMvhd(tail);
    }
    if (t == null) return null;
    const epoch1904 = Date.UTC(1904, 0, 1);
    const ms = epoch1904 + t * 1000;
    // 2000년 이전/미래 값은 무의미(0 = 미설정)
    if (ms < Date.UTC(2000, 0, 1) || ms > Date.now() + DAY) return null;
    return new Date(ms).toISOString();
  } catch { return null; }
}
const DAY = 86_400_000;
function findMvhd(b: Uint8Array): number | null {
  const sig = [0x6d, 0x76, 0x68, 0x64]; // 'mvhd'
  for (let i = 0; i + 24 < b.length; i++) {
    if (b[i] === sig[0] && b[i + 1] === sig[1] && b[i + 2] === sig[2] && b[i + 3] === sig[3]) {
      const version = b[i + 4]!;
      const dv = new DataView(b.buffer, b.byteOffset + i + 8);
      if (version === 1) { const hi = dv.getUint32(0), lo = dv.getUint32(4); return hi * 2 ** 32 + lo; }
      return dv.getUint32(0);
    }
  }
  return null;
}
