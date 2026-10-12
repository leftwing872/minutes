import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Meeting, Team } from "@minutes/shared";
import type { MeetingStore, TeamStore, MeetingPatch } from "./types.js";

/**
 * 단일 테이블 설계
 *  MEETING#<id>  / META            회의 (GSI1: PK="MEETINGS", SK=startUtc)
 *  TEAM#<id>     / META            팀
 *  USER#<sub>    / TEAM#<teamId>   멤버십 (GSI1: PK="TEAM#<id>", SK="USER#<sub>")
 *  MEETING#<id>  / JOB             Transcribe 작업명
 */
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const T = () => process.env.TABLE_NAME!;

export class DynamoMeetingStore implements MeetingStore {
  async insert(m: Meeting) {
    await doc.send(new PutCommand({ TableName: T(), Item: { pk: `MEETING#${m.meetingId}`, sk: "META", gsi1pk: "MEETINGS", gsi1sk: m.startUtc, ...m } }));
  }
  async get(id: string) {
    const r = await doc.send(new GetCommand({ TableName: T(), Key: { pk: `MEETING#${id}`, sk: "META" } }));
    return r.Item ? strip(r.Item) : null;
  }
  async getTranscribeJob(id: string) {
    const r = await doc.send(new GetCommand({ TableName: T(), Key: { pk: `MEETING#${id}`, sk: "JOB" } }));
    return (r.Item?.jobName as string) ?? null;
  }
  async listRange(from: string, to: string) {
    const out: Meeting[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await doc.send(new QueryCommand({
        TableName: T(), IndexName: "gsi1", ScanIndexForward: false,
        KeyConditionExpression: "gsi1pk = :p AND gsi1sk BETWEEN :a AND :b",
        ExpressionAttributeValues: { ":p": "MEETINGS", ":a": from, ":b": to },
        ExclusiveStartKey: key,
      }));
      out.push(...(r.Items ?? []).map(strip));
      key = r.LastEvaluatedKey;
    } while (key);
    return out;
  }
  async listInProgress() {
    // 소규모 앱: 최근 7일 범위에서 필터 (복구 용도)
    const now = Date.now();
    const list = await this.listRange(new Date(now - 7 * 86_400_000).toISOString(), new Date(now + 86_400_000).toISOString());
    return list.filter((m) => ["UPLOADED", "TRANSCRIBING", "REFINING", "SUMMARIZING"].includes(m.status));
  }
  async update(id: string, patch: MeetingPatch) {
    const { transcribeJob, ...rest } = patch;
    if (transcribeJob !== undefined) {
      await doc.send(new PutCommand({ TableName: T(), Item: { pk: `MEETING#${id}`, sk: "JOB", jobName: transcribeJob } }));
    }
    const entries = Object.entries({ ...rest, updatedAt: new Date().toISOString() }).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const names: Record<string, string> = {}, values: Record<string, unknown> = {};
    const sets = entries.map(([k, v], i) => { names[`#k${i}`] = k; values[`:v${i}`] = v; return `#k${i} = :v${i}`; });
    if (rest.startUtc !== undefined) { names["#g"] = "gsi1sk"; values[":g"] = rest.startUtc; sets.push("#g = :g"); }
    await doc.send(new UpdateCommand({
      TableName: T(), Key: { pk: `MEETING#${id}`, sk: "META" },
      UpdateExpression: `SET ${sets.join(", ")}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(pk)",
    }));
  }
  async delete(id: string) {
    await doc.send(new BatchWriteCommand({ RequestItems: { [T()]: [
      { DeleteRequest: { Key: { pk: `MEETING#${id}`, sk: "META" } } },
      { DeleteRequest: { Key: { pk: `MEETING#${id}`, sk: "JOB" } } },
    ] } }));
  }
}

function strip(item: Record<string, any>): Meeting {
  const { pk, sk, gsi1pk, gsi1sk, ...m } = item;
  return m as Meeting;
}

export class DynamoTeamStore implements TeamStore {
  async listTeams(): Promise<Team[]> {
    const r = await doc.send(new QueryCommand({
      TableName: T(), IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :p", ExpressionAttributeValues: { ":p": "TEAMS" },
    }));
    return (r.Items ?? []).map((i) => ({ teamId: i.teamId, name: i.name })).sort((a, b) => a.name.localeCompare(b.name));
  }
  async upsertTeam(teamId: string, name?: string) {
    await doc.send(new PutCommand({
      TableName: T(), Item: { pk: `TEAM#${teamId}`, sk: "META", gsi1pk: "TEAMS", gsi1sk: teamId, teamId, name: name ?? teamId },
      ConditionExpression: "attribute_not_exists(pk)",
    })).catch((e) => { if (e.name !== "ConditionalCheckFailedException") throw e; });
  }
  async userTeams(sub: string): Promise<Team[]> {
    const r = await doc.send(new QueryCommand({
      TableName: T(), KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ExpressionAttributeValues: { ":p": `USER#${sub}`, ":s": "TEAM#" },
    }));
    const ids = (r.Items ?? []).map((i) => i.teamId as string);
    if (!ids.length) return [];
    const all = await this.listTeams();
    return ids.map((id) => all.find((t) => t.teamId === id) ?? { teamId: id, name: id }).sort((a, b) => a.name.localeCompare(b.name));
  }
  async setMembership(sub: string, teamId: string, remove: boolean) {
    if (remove) {
      await doc.send(new DeleteCommand({ TableName: T(), Key: { pk: `USER#${sub}`, sk: `TEAM#${teamId}` } }));
    } else {
      await this.upsertTeam(teamId);
      await doc.send(new PutCommand({ TableName: T(), Item: { pk: `USER#${sub}`, sk: `TEAM#${teamId}`, gsi1pk: `TEAM#${teamId}`, gsi1sk: `USER#${sub}`, teamId, sub } }));
    }
  }
  async removeUser(sub: string) {
    const teams = await this.userTeams(sub);
    for (const t of teams) await this.setMembership(sub, t.teamId, true);
  }
}
