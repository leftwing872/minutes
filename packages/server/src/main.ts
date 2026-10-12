import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { Db, SqliteMeetingStore, SqliteTeamStore, SqliteUserDirectory } from "./store/sqlite.js";
import { LocalPipelineRunner } from "./pipeline/runner.js";
import { buildApi } from "./routes.js";
import { seedDevUser, devAuth } from "./auth.js";
import { hasFfmpeg } from "./audio.js";

const db = new Db(config.dataDir);
seedDevUser(db);
const meetings = new SqliteMeetingStore(db);
const runner = new LocalPipelineRunner(meetings);
await runner.resumeAll();

const app = new Hono();
app.use("*", logger());
app.use("/api/*", cors({ origin: config.webOrigin }));
app.route("/api", buildApi({
  meetings, teams: new SqliteTeamStore(db), users: new SqliteUserDirectory(db), pipeline: runner,
  auth: devAuth(db), qwenEnabled: Boolean(config.qwen.url),
}));
app.onError((e, c) => { console.error(e); return c.json({ error: e.message }, 500); });

if (fs.existsSync(path.join(config.webDist, "index.html"))) {
  const root = path.relative(process.cwd(), config.webDist);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}
if (!(await hasFfmpeg())) console.warn("경고: ffmpeg/ffprobe 를 찾을 수 없습니다.");

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`minutes server  http://localhost:${info.port}  (bucket=${config.bucket}, region=${config.region}, qwen=${config.qwen.url ? "on" : "off"})`);
});
