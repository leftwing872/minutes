import { App } from "aws-cdk-lib";
import { MinutesStack } from "../lib/minutes-stack.js";

const app = new App();
new MinutesStack(app, "Minutes", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
  description: "미팅 노트: 녹음 → Transcribe + Qwen3-ASR → Bedrock 미팅노트",
  adminEmail: app.node.tryGetContext("adminEmail"),
  qwenAsrUrl: app.node.tryGetContext("qwenAsrUrl") ?? "",
  bedrockModelId: app.node.tryGetContext("bedrockModelId") ?? "us.anthropic.claude-sonnet-4-6",
});
