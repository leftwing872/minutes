import { App } from "aws-cdk-lib";
import { MinutesStack } from "../lib/minutes-stack.js";
import { QwenStack } from "../lib/qwen-stack.js";

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" };
const qwenEndpointName: string = app.node.tryGetContext("qwenEndpointName") ?? "";
const dataBucketName: string = app.node.tryGetContext("dataBucketName") ?? "";

// Qwen3-ASR SageMaker 엔드포인트 (별도 스택 — 메인 스택 배포 후 dataBucketName 컨텍스트 필요)
if (qwenEndpointName && dataBucketName) {
  new QwenStack(app, "MinutesQwen", {
    env, description: "미팅 노트: Qwen3-ASR SageMaker 비동기 엔드포인트 (0↔1 오토스케일)",
    dataBucketName, endpointName: qwenEndpointName,
    instanceType: app.node.tryGetContext("qwenInstanceType") ?? "ml.g5.xlarge",
  });
}

new MinutesStack(app, "Minutes", {
  env,
  qwenEndpointName,
  description: "미팅 노트: 녹음 → Transcribe + Qwen3-ASR → Bedrock 미팅노트",
  adminEmail: app.node.tryGetContext("adminEmail"),
  qwenAsrUrl: app.node.tryGetContext("qwenAsrUrl") ?? "",
  bedrockModelId: app.node.tryGetContext("bedrockModelId") ?? "us.anthropic.claude-sonnet-4-6",
});
