import path from "node:path";

const env = (k: string, d?: string): string => {
  const v = process.env[k];
  if (v === undefined || v === "") {
    if (d !== undefined) return d;
    throw new Error(`환경 변수 ${k} 가 필요합니다 (.env 참고)`);
  }
  return v;
};

export const config = {
  port: Number(env("PORT", "8787")),
  region: env("AWS_REGION", "us-east-1"),
  bucket: env("S3_BUCKET"),
  dataDir: path.resolve(env("DATA_DIR", "./data")),
  webOrigin: env("WEB_ORIGIN", "http://localhost:5173"),
  transcribe: {
    language: env("TRANSCRIBE_LANGUAGE", "ko-KR"),
    maxSpeakers: Number(env("TRANSCRIBE_MAX_SPEAKERS", "6")),
  },
  qwen: {
    /** off | http(OpenAI 호환 URL) | sagemaker(비동기 엔드포인트) — 미지정 시 URL/엔드포인트 유무로 결정 */
    mode: (env("QWEN_MODE", "") || (env("QWEN_ENDPOINT_NAME", "") ? "sagemaker" : env("QWEN_ASR_URL", "") ? "http" : "off")) as "off" | "http" | "sagemaker",
    endpointName: env("QWEN_ENDPOINT_NAME", ""),
    url: env("QWEN_ASR_URL", ""),
    apiKey: env("QWEN_ASR_API_KEY", ""),
    model: env("QWEN_ASR_MODEL", "Qwen/Qwen3-ASR-1.7B"),
    chunkSec: Number(env("QWEN_ASR_CHUNK_SEC", "240")),
  },
  bedrock: { modelId: env("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6") },
  devUser: {
    sub: env("DEV_USER_SUB", "local-dev"),
    name: env("DEV_USER_NAME", "개발자"),
    email: env("DEV_USER_EMAIL", "dev@example.com"),
    teams: env("DEV_USER_TEAMS", "my-team").split(",").map((s) => s.trim()).filter(Boolean),
    admin: env("DEV_USER_ADMIN", "true") === "true",
  },
  /** 배포 시 S3 이벤트로 대체. 로컬은 클라이언트가 complete 호출. */
  webDist: path.resolve(env("WEB_DIST", "../web/dist")),
};
export type Config = typeof config;
