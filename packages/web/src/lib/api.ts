import type {
  Meeting, Turns, SessionUser, Team, CreateUploadRequest, CreateUploadResponse, UpdateMeetingRequest, AdminUser,
  InviteUserRequest,
} from "@minutes/shared";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let tokenGetter: () => string | undefined = () => undefined;
/** Cognito 모드에서 id_token 공급자 등록 (로컬 dev 는 미등록) */
export const setTokenGetter = (fn: () => string | undefined) => { tokenGetter = fn; };

async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const token = tokenGetter();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = typeof j.error === "string" ? j.error : JSON.stringify(j.error ?? j); } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  return res;
}
const json = <T,>(r: Response) => r.json() as Promise<T>;

export type Session = { user: SessionUser; teams: Team[]; qwenEnabled: boolean };

export const api = {
  session: () => request("/session").then(json<Session>),
  changePassword: (currentPassword: string, newPassword: string, accessToken?: string) =>
    request("/password", { method: "POST", body: { currentPassword, newPassword, accessToken } }),
  meetings: (fromUtc: string, toUtc: string) =>
    request(`/meetings?${new URLSearchParams({ from: fromUtc, to: toUtc })}`).then(json<Meeting[]>),
  meeting: (id: string) => request(`/meetings/${encodeURIComponent(id)}`).then(json<Meeting>),
  turns: (id: string) => request(`/meetings/${encodeURIComponent(id)}/turns`).then(json<Turns>),
  transcript: (id: string) => request(`/meetings/${encodeURIComponent(id)}/transcript`).then((r) => r.text()),
  note: (id: string) => request(`/meetings/${encodeURIComponent(id)}/note`).then((r) => r.text()),
  saveNote: (id: string, note: string) => request(`/meetings/${encodeURIComponent(id)}/note`, { method: "PUT", body: { note } }),
  createUpload: (body: CreateUploadRequest) => request("/uploads", { method: "POST", body }).then(json<CreateUploadResponse>),
  completeUpload: (id: string) => request(`/uploads/${encodeURIComponent(id)}/complete`, { method: "POST" }).then(json<Meeting>),
  update: (id: string, body: UpdateMeetingRequest) => request(`/meetings/${encodeURIComponent(id)}`, { method: "PATCH", body }).then(json<Meeting>),
  remove: (id: string) => request(`/meetings/${encodeURIComponent(id)}`, { method: "DELETE" }),
  retry: (id: string) => request(`/meetings/${encodeURIComponent(id)}/retry`, { method: "POST" }).then(json<Meeting>),
  renameSpeakers: (id: string, speakers: Record<string, string>) =>
    request(`/meetings/${encodeURIComponent(id)}/speakers`, { method: "POST", body: { speakers } }),
  regenerateNote: (id: string) => request(`/meetings/${encodeURIComponent(id)}/regenerate-note`, { method: "POST" }),
  audioUrl: (id: string) => request(`/meetings/${encodeURIComponent(id)}/audio-url`).then(json<{ url: string }>),
  adminUsers: () => request("/admin/users").then(json<AdminUser[]>),
  inviteUser: (body: InviteUserRequest) =>
    request("/admin/users", { method: "POST", body }).then(json<{ username: string; email: string; password: string }>),
  resetTemporaryPassword: (u: string) =>
    request(`/admin/users/${encodeURIComponent(u)}/reset-password`, { method: "POST" }).then(json<{ username: string; email: string; password: string }>),
  setUserTeam: (u: string, teamId: string, remove = false) =>
    request(`/admin/users/${encodeURIComponent(u)}/teams`, { method: "POST", body: { teamId, remove } }),
  setUserAdmin: (u: string, remove = false) =>
    request(`/admin/users/${encodeURIComponent(u)}/admin`, { method: "POST", body: { remove } }),
  deleteUser: (u: string) => request(`/admin/users/${encodeURIComponent(u)}`, { method: "DELETE" }),
};

/** presigned PUT 업로드 (진행률 콜백) */
export function uploadToS3(url: string, body: Blob, contentType: string, onProgress?: (ratio: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
      ? resolve()
      : reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText.slice(0, 200)}`));
    xhr.onerror = () => reject(new Error("Upload failed (network error)"));
    xhr.send(body);
  });
}
