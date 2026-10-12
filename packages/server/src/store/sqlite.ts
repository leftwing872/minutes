import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Meeting, Team, AdminUser } from "@minutes/shared";

export type UserRow = {
  username: string;
  sub: string;
  email: string;
  name: string;
  is_admin: number;
  status: "CONFIRMED" | "FORCE_CHANGE_PASSWORD";
  created_at: string;
};

export class Db {
  readonly sql: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.sql = new Database(path.join(dataDir, "minutes.sqlite"));
    this.sql.pragma("journal_mode = WAL");
    this.sql.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        meeting_id TEXT PRIMARY KEY,
        owner_sub TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        start_utc TEXT NOT NULL,
        duration_sec REAL,
        time_source TEXT NOT NULL,
        attendees TEXT NOT NULL DEFAULT '[]',
        team_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        status_message TEXT,
        original_filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        bytes INTEGER,
        note_preview TEXT,
        note_edited_at TEXT,
        speakers TEXT NOT NULL DEFAULT '{}',
        has_refined INTEGER NOT NULL DEFAULT 0,
        transcribe_job TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_utc);
      CREATE TABLE IF NOT EXISTS teams (team_id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        sub TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'CONFIRMED',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
        PRIMARY KEY (username, team_id)
      );
    `);
  }

  // ---------- meetings ----------
  private rowToMeeting(r: any): Meeting {
    return {
      meetingId: r.meeting_id,
      ownerSub: r.owner_sub,
      ownerName: r.owner_name,
      title: r.title,
      startUtc: r.start_utc,
      durationSec: r.duration_sec ?? null,
      timeSource: r.time_source,
      attendees: JSON.parse(r.attendees),
      teamIds: JSON.parse(r.team_ids),
      status: r.status,
      statusMessage: r.status_message ?? null,
      originalFilename: r.original_filename,
      contentType: r.content_type,
      bytes: r.bytes ?? null,
      notePreview: r.note_preview ?? null,
      noteEditedAt: r.note_edited_at ?? null,
      speakers: JSON.parse(r.speakers),
      hasRefined: !!r.has_refined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  insertMeeting(m: Meeting) {
    this.sql
      .prepare(
        `INSERT INTO meetings (meeting_id, owner_sub, owner_name, title, start_utc, duration_sec, time_source,
          attendees, team_ids, status, status_message, original_filename, content_type, bytes, note_preview,
          note_edited_at, speakers, has_refined, created_at, updated_at)
         VALUES (@meetingId, @ownerSub, @ownerName, @title, @startUtc, @durationSec, @timeSource,
          @attendees, @teamIds, @status, @statusMessage, @originalFilename, @contentType, @bytes, @notePreview,
          @noteEditedAt, @speakers, @hasRefined, @createdAt, @updatedAt)`,
      )
      .run({
        ...m,
        attendees: JSON.stringify(m.attendees),
        teamIds: JSON.stringify(m.teamIds),
        speakers: JSON.stringify(m.speakers),
        hasRefined: m.hasRefined ? 1 : 0,
      });
  }

  getMeeting(id: string): Meeting | null {
    const r = this.sql.prepare(`SELECT * FROM meetings WHERE meeting_id = ?`).get(id);
    return r ? this.rowToMeeting(r) : null;
  }

  getTranscribeJob(id: string): string | null {
    const r = this.sql.prepare(`SELECT transcribe_job FROM meetings WHERE meeting_id = ?`).get(id) as any;
    return r?.transcribe_job ?? null;
  }

  listMeetingsRange(fromUtc: string, toUtc: string): Meeting[] {
    const rows = this.sql
      .prepare(`SELECT * FROM meetings WHERE start_utc >= ? AND start_utc < ? ORDER BY start_utc DESC`)
      .all(fromUtc, toUtc) as any[];
    return rows.map((r) => this.rowToMeeting(r));
  }

  /** 아직 끝나지 않은 처리(서버 재시작 복구용) */
  listInProgress(): Meeting[] {
    const rows = this.sql
      .prepare(`SELECT * FROM meetings WHERE status IN ('UPLOADED','TRANSCRIBING','REFINING','SUMMARIZING')`)
      .all() as any[];
    return rows.map((r) => this.rowToMeeting(r));
  }

  updateMeeting(
    id: string,
    patch: Partial<
      Pick<
        Meeting,
        | "title" | "startUtc" | "durationSec" | "timeSource" | "attendees" | "teamIds" | "status"
        | "statusMessage" | "bytes" | "notePreview" | "noteEditedAt" | "speakers" | "hasRefined"
      >
    > & { transcribeJob?: string | null },
  ) {
    const sets: string[] = ["updated_at = @updatedAt"];
    const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };
    const map: Record<string, [string, (v: any) => unknown]> = {
      title: ["title", (v) => v],
      startUtc: ["start_utc", (v) => v],
      durationSec: ["duration_sec", (v) => v],
      timeSource: ["time_source", (v) => v],
      attendees: ["attendees", (v) => JSON.stringify(v)],
      teamIds: ["team_ids", (v) => JSON.stringify(v)],
      status: ["status", (v) => v],
      statusMessage: ["status_message", (v) => v],
      bytes: ["bytes", (v) => v],
      notePreview: ["note_preview", (v) => v],
      noteEditedAt: ["note_edited_at", (v) => v],
      speakers: ["speakers", (v) => JSON.stringify(v)],
      hasRefined: ["has_refined", (v) => (v ? 1 : 0)],
      transcribeJob: ["transcribe_job", (v) => v],
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      const m = map[k];
      if (!m) continue;
      sets.push(`${m[0]} = @${k}`);
      params[k] = m[1](v);
    }
    this.sql.prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE meeting_id = @id`).run(params);
  }

  deleteMeeting(id: string) {
    this.sql.prepare(`DELETE FROM meetings WHERE meeting_id = ?`).run(id);
  }

  // ---------- teams / users ----------
  listTeams(): Team[] {
    return (this.sql.prepare(`SELECT team_id AS teamId, name FROM teams ORDER BY name`).all() as Team[]);
  }

  upsertTeam(teamId: string, name?: string) {
    this.sql
      .prepare(`INSERT INTO teams (team_id, name) VALUES (?, ?) ON CONFLICT(team_id) DO NOTHING`)
      .run(teamId, name ?? teamId);
  }

  getUser(username: string): UserRow | null {
    return (this.sql.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow) ?? null;
  }

  getUserBySub(sub: string): UserRow | null {
    return (this.sql.prepare(`SELECT * FROM users WHERE sub = ?`).get(sub) as UserRow) ?? null;
  }

  upsertUser(u: Omit<UserRow, "created_at">) {
    this.sql
      .prepare(
        `INSERT INTO users (username, sub, email, name, is_admin, status, created_at)
         VALUES (@username, @sub, @email, @name, @is_admin, @status, @created_at)
         ON CONFLICT(username) DO UPDATE SET email=excluded.email, name=excluded.name`,
      )
      .run({ ...u, created_at: new Date().toISOString() });
  }

  userTeams(username: string): Team[] {
    return this.sql
      .prepare(
        `SELECT t.team_id AS teamId, t.name FROM memberships m JOIN teams t ON t.team_id = m.team_id
         WHERE m.username = ? ORDER BY t.name`,
      )
      .all(username) as Team[];
  }

  setMembership(username: string, teamId: string, remove: boolean) {
    if (remove) {
      this.sql.prepare(`DELETE FROM memberships WHERE username = ? AND team_id = ?`).run(username, teamId);
    } else {
      this.upsertTeam(teamId);
      this.sql
        .prepare(`INSERT OR IGNORE INTO memberships (username, team_id) VALUES (?, ?)`)
        .run(username, teamId);
    }
  }

  setAdmin(username: string, admin: boolean) {
    this.sql.prepare(`UPDATE users SET is_admin = ? WHERE username = ?`).run(admin ? 1 : 0, username);
  }

  setUserStatus(username: string, status: UserRow["status"]) {
    this.sql.prepare(`UPDATE users SET status = ? WHERE username = ?`).run(status, username);
  }

  deleteUser(username: string) {
    this.sql.prepare(`DELETE FROM users WHERE username = ?`).run(username);
  }

  listUsers(): AdminUser[] {
    const rows = this.sql.prepare(`SELECT * FROM users ORDER BY created_at`).all() as UserRow[];
    return rows.map((r) => ({
      username: r.username,
      email: r.email,
      name: r.name,
      isAdmin: !!r.is_admin,
      teams: this.userTeams(r.username),
      status: r.status,
      createdAt: r.created_at,
    }));
  }
}


// ---------- 인터페이스 어댑터 ----------
import type { MeetingStore, TeamStore, UserDirectory, InviteResult, MeetingPatch } from "./types.js";
import type { SessionUser } from "@minutes/shared";
import { randomUUID } from "node:crypto";
import { tempPassword } from "../users/password.js";

export class SqliteMeetingStore implements MeetingStore {
  constructor(private db: Db) {}
  async insert(m: Meeting) { this.db.insertMeeting(m); }
  async get(id: string) { return this.db.getMeeting(id); }
  async getTranscribeJob(id: string) { return this.db.getTranscribeJob(id); }
  async listRange(from: string, to: string) { return this.db.listMeetingsRange(from, to); }
  async listInProgress() { return this.db.listInProgress(); }
  async update(id: string, patch: MeetingPatch) { this.db.updateMeeting(id, patch); }
  async delete(id: string) { this.db.deleteMeeting(id); }
}

export class SqliteTeamStore implements TeamStore {
  constructor(private db: Db) {}
  async listTeams() { return this.db.listTeams(); }
  async upsertTeam(id: string, name?: string) { this.db.upsertTeam(id, name); }
  async userTeams(sub: string) { return this.db.userTeams(sub); }
  async setMembership(sub: string, teamId: string, remove: boolean) { this.db.setMembership(sub, teamId, remove); }
  async removeUser(sub: string) { this.db.deleteUser(sub); }
}

/** 로컬 사용자 디렉터리: username === sub */
export class SqliteUserDirectory implements UserDirectory {
  constructor(private db: Db) {}
  async listUsers() { return this.db.listUsers(); }
  async invite(email: string, name: string): Promise<InviteResult> {
    const username = email.toLowerCase();
    if (this.db.getUser(username)) throw Object.assign(new Error("이미 존재하는 사용자입니다."), { status: 409 });
    this.db.upsertUser({ username, sub: username, email, name, is_admin: 0, status: "FORCE_CHANGE_PASSWORD" });
    return { username, email, password: tempPassword() };
  }
  async resetTemporaryPassword(username: string): Promise<InviteResult> {
    const u = this.db.getUser(username);
    if (!u) throw Object.assign(new Error("없는 사용자"), { status: 404 });
    this.db.setUserStatus(username, "FORCE_CHANGE_PASSWORD");
    return { username, email: u.email, password: tempPassword() };
  }
  async setAdmin(username: string, admin: boolean) { this.db.setAdmin(username, admin); }
  async deleteUser(username: string) { this.db.deleteUser(username); }
  async resolveSub(username: string) { return this.db.getUser(username)?.sub ?? null; }
  async changePassword(_u: SessionUser) { /* 로컬 모드: 비밀번호 없음 */ }
}
