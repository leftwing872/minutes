import type { Meeting, Team, AdminUser, SessionUser } from "@minutes/shared";

export type MeetingPatch = Partial<
  Pick<Meeting, "title" | "startUtc" | "durationSec" | "timeSource" | "attendees" | "teamIds" | "status"
    | "statusMessage" | "bytes" | "notePreview" | "noteEditedAt" | "speakers" | "hasRefined">
> & { transcribeJob?: string | null };

/** 회의 메타데이터 저장소 (로컬: SQLite, 배포: DynamoDB) */
export interface MeetingStore {
  insert(m: Meeting): Promise<void>;
  get(id: string): Promise<Meeting | null>;
  getTranscribeJob(id: string): Promise<string | null>;
  /** [fromUtc, toUtc) 범위, startUtc 내림차순. 가시성 필터는 호출자가 수행 */
  listRange(fromUtc: string, toUtc: string): Promise<Meeting[]>;
  listInProgress(): Promise<Meeting[]>;
  update(id: string, patch: MeetingPatch): Promise<void>;
  delete(id: string): Promise<void>;
}

/** 팀과 사용자(sub)-팀 멤버십 */
export interface TeamStore {
  listTeams(): Promise<Team[]>;
  upsertTeam(teamId: string, name?: string): Promise<void>;
  userTeams(sub: string): Promise<Team[]>;
  setMembership(sub: string, teamId: string, remove: boolean): Promise<void>;
  removeUser(sub: string): Promise<void>;
}

export type InviteResult = { username: string; email: string; password: string };

/** 사용자 디렉터리 (로컬: SQLite, 배포: Cognito) */
export interface UserDirectory {
  listUsers(): Promise<AdminUser[]>;
  invite(email: string, name: string): Promise<InviteResult>;
  resetTemporaryPassword(username: string): Promise<InviteResult>;
  setAdmin(username: string, admin: boolean): Promise<void>;
  deleteUser(username: string): Promise<void>;
  /** username → sub (멤버십 키) */
  resolveSub(username: string): Promise<string | null>;
  /** 비밀번호 변경. accessToken 은 Cognito 모드에서만 사용 */
  changePassword(user: SessionUser, currentPassword: string, newPassword: string, accessToken?: string): Promise<void>;
}

export interface PipelineStarter {
  /** 업로드 완료/재시도: UPLOADED 상태부터 전체 파이프라인 */
  start(meetingId: string): Promise<void>;
  /** 노트만 다시 생성 */
  regenerate(meetingId: string): Promise<void>;
}

export const visibleTo = (m: Meeting, sub: string, teamIds: string[]) =>
  m.ownerSub === sub || m.teamIds.some((t) => teamIds.includes(t));
