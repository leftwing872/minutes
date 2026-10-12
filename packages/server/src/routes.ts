import { Hono, type MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import {
  CreateUploadRequest, UpdateMeetingRequest, RenameSpeakersRequest, InviteUserRequest, type Meeting, type SessionUser, type Turns,
} from "@minutes/shared";
import type { MeetingStore, TeamStore, UserDirectory, PipelineStarter } from "./store/types.js";
import { visibleTo } from "./store/types.js";
import { keys, presignPut, presignGet, headObject, getJson, getText, putText, deletePrefix } from "./aws.js";
import { notePreview } from "./pipeline/summarize.js";
import { requireAdmin, type AuthEnv } from "./auth.js";

export type Deps = {
  meetings: MeetingStore; teams: TeamStore; users: UserDirectory; pipeline: PipelineStarter;
  auth: MiddlewareHandler<AuthEnv>; qwenEnabled: boolean;
};

export function buildApi(d: Deps) {
  const api = new Hono<AuthEnv>();
  api.use("*", d.auth);

  const canEdit = (m: Meeting, u: SessionUser) => m.ownerSub === u.sub || u.isAdmin;
  const isRes = (x: unknown): x is Response => x instanceof Response;
  const loadMeeting = async (c: any, edit = false): Promise<Meeting | Response> => {
    const u: SessionUser = c.get("user");
    const m = await d.meetings.get(c.req.param("id"));
    if (!m || !visibleTo(m, u.sub, u.teams.map((t) => t.teamId))) return c.json({ error: "회의를 찾을 수 없습니다." }, 404);
    if (edit && !canEdit(m, u)) return c.json({ error: "수정 권한이 없습니다." }, 403);
    return m;
  };
  const audioKey = (m: Meeting) => keys.audio(m.meetingId, m.originalFilename);

  // ---------- 세션 ----------
  api.get("/session", async (c) => c.json({ user: c.get("user"), teams: await d.teams.listTeams(), qwenEnabled: d.qwenEnabled }));
  api.post("/password", async (c) => {
    const { currentPassword, newPassword, accessToken } = (await c.req.json()) as Record<string, string>;
    if (!currentPassword || !newPassword) return c.json({ error: "비밀번호를 입력해 주세요." }, 400);
    await d.users.changePassword(c.get("user"), currentPassword, newPassword, accessToken);
    return c.json({ ok: true });
  });

  // ---------- 회의 ----------
  api.get("/meetings", async (c) => {
    const u = c.get("user");
    const from = c.req.query("from") ?? "1970-01-01T00:00:00Z", to = c.req.query("to") ?? "2999-01-01T00:00:00Z";
    const ids = u.teams.map((t) => t.teamId);
    return c.json((await d.meetings.listRange(from, to)).filter((m) => visibleTo(m, u.sub, ids)));
  });

  api.post("/uploads", async (c) => {
    const u = c.get("user");
    const body = CreateUploadRequest.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const b = body.data, now = new Date().toISOString(), meetingId = randomUUID();
    const myTeams = u.teams.map((t) => t.teamId);
    const m: Meeting = {
      meetingId, ownerSub: u.sub, ownerName: u.name, title: b.title?.trim() ?? "",
      startUtc: b.startUtc ?? now, durationSec: b.durationSec ?? null,
      timeSource: b.timeSource ?? (b.startUtc ? "manual" : "upload"),
      attendees: b.attendees ?? [], teamIds: (b.teamIds ?? []).filter((t) => myTeams.includes(t)),
      status: "PENDING_UPLOAD", statusMessage: null, originalFilename: b.filename, contentType: b.contentType, bytes: null,
      notePreview: null, noteEditedAt: null, speakers: {}, hasRefined: false, createdAt: now, updatedAt: now,
    };
    await d.meetings.insert(m);
    return c.json({ meetingId, uploadUrl: await presignPut(audioKey(m), b.contentType), completeUrl: `/api/uploads/${meetingId}/complete` });
  });

  /** 클라이언트가 S3 PUT 완료 후 호출. 배포 환경에서는 S3 이벤트가 먼저 처리했을 수 있음(그 경우 no-op). */
  api.post("/uploads/:id/complete", async (c) => {
    const m = await loadMeeting(c, true); if (isRes(m)) return m;
    if (m.status !== "PENDING_UPLOAD") return c.json(m);
    const head = await headObject(audioKey(m));
    if (!head) return c.json({ error: "S3에 파일이 없습니다. 업로드가 완료되지 않았습니다." }, 409);
    await d.meetings.update(m.meetingId, { status: "UPLOADED", statusMessage: null, bytes: head.bytes });
    await d.pipeline.start(m.meetingId);
    return c.json(await d.meetings.get(m.meetingId));
  });

  api.get("/meetings/:id", async (c) => { const m = await loadMeeting(c); return isRes(m) ? m : c.json(m); });

  api.patch("/meetings/:id", async (c) => {
    const m = await loadMeeting(c, true); if (isRes(m)) return m;
    const body = UpdateMeetingRequest.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const p = body.data;
    await d.meetings.update(m.meetingId, {
      ...(p.title !== undefined ? { title: p.title.trim() } : {}),
      ...(p.startUtc !== undefined ? { startUtc: p.startUtc, timeSource: "manual" } : {}),
      ...(p.attendees !== undefined ? { attendees: p.attendees } : {}),
      ...(p.teamIds !== undefined ? { teamIds: p.teamIds } : {}),
    });
    return c.json(await d.meetings.get(m.meetingId));
  });

  api.delete("/meetings/:id", async (c) => {
    const m = await loadMeeting(c, true); if (isRes(m)) return m;
    await deletePrefix(keys.prefix(m.meetingId));
    await d.meetings.delete(m.meetingId);
    return c.body(null, 204);
  });

  api.post("/meetings/:id/retry", async (c) => {
    const m = await loadMeeting(c, true); if (isRes(m)) return m;
    if (m.status !== "FAILED") return c.json(m);
    await d.meetings.update(m.meetingId, { status: "UPLOADED", statusMessage: null });
    await d.pipeline.start(m.meetingId);
    return c.json(await d.meetings.get(m.meetingId));
  });

  api.get("/meetings/:id/turns", async (c) => {
    const m = await loadMeeting(c); if (isRes(m)) return m;
    return c.json((await getJson<Turns>(keys.turns(m.meetingId))) ?? { raw: [], refined: null });
  });

  api.get("/meetings/:id/transcript", async (c) => {
    const m = await loadMeeting(c); if (isRes(m)) return m;
    const t = await getJson<Turns>(keys.turns(m.meetingId));
    const src = t?.refined ?? t?.raw ?? [];
    return c.text(src.map((x) => `${m.speakers[x.speaker] ?? x.speaker}: ${x.text}`).join("\n"));
  });

  api.get("/meetings/:id/note", async (c) => {
    const m = await loadMeeting(c); if (isRes(m)) return m;
    return c.text((await getText(keys.note(m.meetingId))) ?? "");
  });

  api.put("/meetings/:id/note", async (c) => {
    const m = await loadMeeting(c, true); if (isRes(m)) return m;
    const { note } = (await c.req.json()) as { note?: string };
    if (typeof note !== "string") return c.json({ error: "note 가 필요합니다." }, 400);
    await putText(keys.note(m.meetingId), note, "text/markdown; charset=utf-8");
    await d.meetings.update(m.meetingId, { notePreview: notePreview(note), noteEditedAt: new Date().toISOString() });
    return c.json(await d.meetings.get(m.meetingId));
  });

  api.post("/meetings/:id/speakers", async (c) => {
    const m = await loadMeeting(c, true); if (isRes(m)) return m;
    const body = RenameSpeakersRequest.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    await d.meetings.update(m.meetingId, { speakers: { ...m.speakers, ...body.data.speakers } });
    return c.json(await d.meetings.get(m.meetingId));
  });

  api.post("/meetings/:id/regenerate-note", async (c) => {
    const m = await loadMeeting(c, true); if (isRes(m)) return m;
    if (m.status !== "DONE") return c.json({ error: "처리가 끝난 회의만 재생성할 수 있습니다." }, 409);
    await d.meetings.update(m.meetingId, { status: "SUMMARIZING", statusMessage: null });
    await d.pipeline.regenerate(m.meetingId);
    return c.json(await d.meetings.get(m.meetingId));
  });

  api.get("/meetings/:id/audio-url", async (c) => {
    const m = await loadMeeting(c); if (isRes(m)) return m;
    return c.json({ url: await presignGet(audioKey(m), m.originalFilename) });
  });

  // ---------- 관리자 ----------
  const admin = new Hono<AuthEnv>();
  admin.use("*", requireAdmin);
  admin.get("/users", async (c) => c.json(await d.users.listUsers()));
  admin.post("/users", async (c) => {
    const body = InviteUserRequest.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const b = body.data;
    const r = await d.users.invite(b.email, b.name);
    await d.teams.upsertTeam(b.teamId, b.newTeamName);
    const sub = await d.users.resolveSub(r.username);
    if (sub) await d.teams.setMembership(sub, b.teamId, false);
    return c.json(r);
  });
  admin.post("/users/:u/reset-password", async (c) => c.json(await d.users.resetTemporaryPassword(c.req.param("u"))));
  admin.post("/users/:u/teams", async (c) => {
    const { teamId, remove } = (await c.req.json()) as { teamId: string; remove?: boolean };
    if (!/^[a-z0-9-]{2,31}$/.test(teamId ?? "")) return c.json({ error: "팀 이름 형식 오류" }, 400);
    const sub = await d.users.resolveSub(c.req.param("u"));
    if (!sub) return c.json({ error: "없는 사용자" }, 404);
    await d.teams.setMembership(sub, teamId, !!remove);
    return c.body(null, 204);
  });
  admin.post("/users/:u/admin", async (c) => {
    const { remove } = (await c.req.json().catch(() => ({}))) as { remove?: boolean };
    await d.users.setAdmin(c.req.param("u"), !remove);
    return c.body(null, 204);
  });
  admin.delete("/users/:u", async (c) => { await d.users.deleteUser(c.req.param("u")); return c.body(null, 204); });
  api.route("/admin", admin);

  api.onError((e: any, c) => {
    const status = typeof e?.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error(e);
    return c.json({ error: e?.message ?? "오류" }, status);
  });
  return api;
}
