import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { buildApi } from "../routes.js";
import { DynamoMeetingStore, DynamoTeamStore } from "../store/dynamo.js";
import { CognitoUserDirectory } from "../users/cognito.js";
import { SfnPipelineStarter } from "../pipeline/sfn.js";
import { cognitoAuth } from "../auth.js";

const teams = new DynamoTeamStore();
const app = new Hono();
app.route("/api", buildApi({
  meetings: new DynamoMeetingStore(), teams, users: new CognitoUserDirectory(teams),
  pipeline: new SfnPipelineStarter(process.env.STATE_MACHINE_ARN!),
  auth: cognitoAuth(teams), qwenEnabled: Boolean(process.env.QWEN_ENDPOINT_NAME || process.env.QWEN_ASR_URL),
}));
app.onError((e, c) => { console.error(e); return c.json({ error: e.message }, 500); });

export const handler = handle(app);
