import { z } from "zod";

/** 처리 파이프라인 상태 (동료 앱과 동일) */
export const MeetingStatus = z.enum([
  "PENDING_UPLOAD",
  "UPLOADED",
  "TRANSCRIBING",
  "REFINING",
  "SUMMARIZING",
  "DONE",
  "FAILED",
]);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

export const isTerminal = (s: MeetingStatus) => s === "DONE" || s === "FAILED";

/** 회의 시작 시각의 출처 */
export const TimeSource = z.enum(["file", "recorder", "manual", "upload"]);
export type TimeSource = z.infer<typeof TimeSource>;

export const Visibility = z.object({
  /** 빈 배열이면 "나만 보기" */
  teamIds: z.array(z.string()),
});

export const Meeting = z.object({
  meetingId: z.string(),
  ownerSub: z.string(),
  ownerName: z.string(),
  title: z.string(),
  /** ISO 8601 UTC */
  startUtc: z.string(),
  durationSec: z.number().nullable(),
  timeSource: TimeSource,
  attendees: z.array(z.string()),
  teamIds: z.array(z.string()),
  status: MeetingStatus,
  statusMessage: z.string().nullable(),
  originalFilename: z.string(),
  contentType: z.string(),
  bytes: z.number().nullable(),
  /** 노트 첫 줄들 (목록 미리보기) */
  notePreview: z.string().nullable(),
  /** 사용자가 노트를 직접 수정한 시각 */
  noteEditedAt: z.string().nullable(),
  /** 화자 라벨(spk_0 …) → 표시 이름 */
  speakers: z.record(z.string(), z.string()),
  hasRefined: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Meeting = z.infer<typeof Meeting>;

export const Turn = z.object({
  speaker: z.string(),
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
});
export type Turn = z.infer<typeof Turn>;

export const Turns = z.object({
  /** "raw" = Transcribe 원문, "refined" = 두 전사문 대조 보정본 */
  raw: z.array(Turn),
  refined: z.array(Turn).nullable(),
});
export type Turns = z.infer<typeof Turns>;

export const Team = z.object({ teamId: z.string(), name: z.string() });
export type Team = z.infer<typeof Team>;

export const SessionUser = z.object({
  sub: z.string(),
  username: z.string(),
  email: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
  teams: z.array(Team),
});
export type SessionUser = z.infer<typeof SessionUser>;

export const CreateUploadRequest = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  title: z.string().optional(),
  startUtc: z.string().optional(),
  durationSec: z.number().optional(),
  timeSource: TimeSource.optional(),
  attendees: z.array(z.string()).optional(),
  teamIds: z.array(z.string()).optional(),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export const CreateUploadResponse = z.object({
  meetingId: z.string(),
  uploadUrl: z.string(),
  /** 업로드 완료 후 호출할 경로 */
  completeUrl: z.string(),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;

export const UpdateMeetingRequest = z.object({
  title: z.string().optional(),
  startUtc: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  teamIds: z.array(z.string()).optional(),
});
export type UpdateMeetingRequest = z.infer<typeof UpdateMeetingRequest>;

export const RenameSpeakersRequest = z.object({
  speakers: z.record(z.string(), z.string()),
});

export const AdminUser = z.object({
  username: z.string(),
  email: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
  teams: z.array(Team),
  /** FORCE_CHANGE_PASSWORD 등 Cognito 상태에 대응 */
  status: z.enum(["CONFIRMED", "FORCE_CHANGE_PASSWORD"]),
  createdAt: z.string(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const InviteUserRequest = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  teamId: z.string().regex(/^[a-z0-9-]{2,31}$/),
  newTeamName: z.string().optional(),
});
export type InviteUserRequest = z.infer<typeof InviteUserRequest>;

export const InviteUserResponse = z.object({
  username: z.string(),
  email: z.string(),
  password: z.string(),
});

/** 상태 배지 텍스트 (동료 앱과 동일) */
export const STATUS_LABEL: Record<MeetingStatus, string> = {
  PENDING_UPLOAD: "업로드 대기",
  UPLOADED: "업로드됨",
  TRANSCRIBING: "전사 중",
  REFINING: "정밀 전사 중",
  SUMMARIZING: "노트 생성 중",
  DONE: "완료",
  FAILED: "실패",
};
