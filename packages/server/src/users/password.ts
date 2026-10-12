import { randomBytes } from "node:crypto";

/** Cognito 임시 비밀번호 규칙과 동일: 12자 이상, 대/소문자·숫자·기호 */
export function tempPassword() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*"];
  const pick = (s: string) => s[randomBytes(1)[0]! % s.length]!;
  const chars = [...sets.map(pick), ...Array.from({ length: 10 }, () => pick(sets.join("")))];
  return chars.sort(() => randomBytes(1)[0]! - 128).join("");
}
