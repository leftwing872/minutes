import type { Context, MiddlewareHandler } from "hono";
import type { SessionUser } from "@minutes/shared";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Db } from "./store/sqlite.js";
import type { TeamStore } from "./store/types.js";
import { config } from "./config.js";
import { ADMIN_GROUP } from "./users/cognito.js";

export type AuthEnv = { Variables: { user: SessionUser; accessToken?: string } };

/** 로컬 개발용: .env 의 DEV_USER 를 항상 로그인된 사용자로 취급 */
export function seedDevUser(db: Db) {
  const d = config.devUser;
  db.upsertUser({ username: d.sub, sub: d.sub, email: d.email, name: d.name, is_admin: d.admin ? 1 : 0, status: "CONFIRMED" });
  if (d.admin) db.setAdmin(d.sub, true);
  for (const t of d.teams) db.setMembership(d.sub, t, false);
}

export function devAuth(db: Db): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const row = db.getUserBySub(config.devUser.sub);
    if (!row) return c.json({ error: "로그인이 필요합니다." }, 401);
    c.set("user", { sub: row.sub, username: row.username, email: row.email, name: row.name, isAdmin: !!row.is_admin, teams: db.userTeams(row.username) });
    await next();
  };
}

/**
 * 배포용: `Authorization: Bearer <Cognito id_token>` 검증.
 * email/name/그룹은 토큰 클레임에서, 팀은 TeamStore 에서 읽는다.
 */
export function cognitoAuth(teams: TeamStore): MiddlewareHandler<AuthEnv> {
  const verifier = CognitoJwtVerifier.create({ userPoolId: process.env.USER_POOL_ID!, tokenUse: "id", clientId: null });
  return async (c, next) => {
    const h = c.req.header("authorization") ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return c.json({ error: "로그인이 필요합니다." }, 401);
    let p: Awaited<ReturnType<typeof verifier.verify>>;
    try { p = await verifier.verify(token); } catch { return c.json({ error: "세션이 만료되었습니다. 다시 로그인해 주세요." }, 401); }
    const sub = p.sub, email = (p["email"] as string) ?? "", name = (p["name"] as string) || email;
    const groups = (p["cognito:groups"] as string[] | undefined) ?? [];
    c.set("user", { sub, username: (p["cognito:username"] as string) ?? sub, email, name, isAdmin: groups.includes(ADMIN_GROUP), teams: await teams.userTeams(sub) });
    await next();
  };
}

export const requireAdmin = async (c: Context<AuthEnv>, next: () => Promise<void>) => {
  if (!c.get("user").isAdmin) return c.json({ error: "관리자 권한이 필요합니다." }, 403);
  await next();
};
