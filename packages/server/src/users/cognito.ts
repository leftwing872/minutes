import {
  CognitoIdentityProviderClient, ListUsersCommand, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand, AdminDeleteUserCommand, AdminGetUserCommand, ListUsersInGroupCommand, ChangePasswordCommand,
  type UserType, type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AdminUser, SessionUser } from "@minutes/shared";
import type { TeamStore, UserDirectory, InviteResult } from "../store/types.js";
import { tempPassword } from "./password.js";

export const ADMIN_GROUP = "admins";
const cognito = new CognitoIdentityProviderClient({});
const POOL = () => process.env.USER_POOL_ID!;
const attr = (a: AttributeType[] | undefined, n: string) => a?.find((x) => x.Name === n)?.Value ?? "";

/** Cognito User Pool 기반 사용자 디렉터리. 멤버십은 TeamStore(DynamoDB)에 sub 키로 저장 */
export class CognitoUserDirectory implements UserDirectory {
  constructor(private teams: TeamStore) {}

  async listUsers(): Promise<AdminUser[]> {
    const users: UserType[] = [];
    let token: string | undefined;
    do {
      const r = await cognito.send(new ListUsersCommand({ UserPoolId: POOL(), PaginationToken: token, Limit: 60 }));
      users.push(...(r.Users ?? [])); token = r.PaginationToken;
    } while (token);
    const admins = new Set<string>();
    let gt: string | undefined;
    do {
      const r = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: POOL(), GroupName: ADMIN_GROUP, NextToken: gt }));
      for (const u of r.Users ?? []) admins.add(u.Username!); gt = r.NextToken;
    } while (gt);
    return Promise.all(users.map(async (u) => {
      const sub = attr(u.Attributes, "sub");
      return {
        username: u.Username!, email: attr(u.Attributes, "email"), name: attr(u.Attributes, "name"),
        isAdmin: admins.has(u.Username!), teams: await this.teams.userTeams(sub),
        status: u.UserStatus === "FORCE_CHANGE_PASSWORD" ? "FORCE_CHANGE_PASSWORD" : "CONFIRMED",
        createdAt: u.UserCreateDate?.toISOString() ?? "",
      } satisfies AdminUser;
    }));
  }

  async invite(email: string, name: string): Promise<InviteResult> {
    const password = tempPassword();
    try {
      const r = await cognito.send(new AdminCreateUserCommand({
        UserPoolId: POOL(), Username: email, TemporaryPassword: password, MessageAction: "SUPPRESS",
        UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }, { Name: "name", Value: name }],
      }));
      return { username: r.User!.Username!, email, password };
    } catch (e: any) {
      if (e.name === "UsernameExistsException") throw Object.assign(new Error("이미 존재하는 사용자입니다."), { status: 409 });
      throw e;
    }
  }

  async resetTemporaryPassword(username: string): Promise<InviteResult> {
    const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL(), Username: username }));
    const password = tempPassword();
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL(), Username: username, Password: password, Permanent: false }));
    return { username, email: attr(u.UserAttributes, "email"), password };
  }

  async setAdmin(username: string, admin: boolean) {
    const cmd = admin ? new AdminAddUserToGroupCommand({ UserPoolId: POOL(), Username: username, GroupName: ADMIN_GROUP })
      : new AdminRemoveUserFromGroupCommand({ UserPoolId: POOL(), Username: username, GroupName: ADMIN_GROUP });
    await cognito.send(cmd);
  }

  async deleteUser(username: string) {
    const sub = await this.resolveSub(username);
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL(), Username: username }));
    if (sub) await this.teams.removeUser(sub);
  }

  async resolveSub(username: string) {
    try {
      const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL(), Username: username }));
      return attr(u.UserAttributes, "sub") || null;
    } catch (e: any) {
      if (e.name === "UserNotFoundException") return null;
      throw e;
    }
  }

  async changePassword(_u: SessionUser, currentPassword: string, newPassword: string, accessToken?: string) {
    if (!accessToken) throw Object.assign(new Error("accessToken 이 필요합니다."), { status: 400 });
    try {
      await cognito.send(new ChangePasswordCommand({ AccessToken: accessToken, PreviousPassword: currentPassword, ProposedPassword: newPassword }));
    } catch (e: any) {
      if (e.name === "NotAuthorizedException") throw Object.assign(new Error("현재 비밀번호가 올바르지 않습니다."), { status: 400 });
      if (e.name === "InvalidPasswordException") throw Object.assign(new Error("비밀번호 정책을 만족하지 않습니다."), { status: 400 });
      if (e.name === "LimitExceededException") throw Object.assign(new Error("시도 횟수를 초과했습니다. 잠시 후 다시 시도하세요."), { status: 429 });
      throw e;
    }
  }
}
