import { beforeAll, describe, expect, it } from "vitest";
import { addSigningKey, connect, push, serveJwks, signToken, type SigningKey } from "./helpers";

let key: SigningKey;

beforeAll(async () => {
  serveJwks();
  key = await addSigningKey("k1");
});

const message = { id: crypto.randomUUID(), type: "timer.updated", payload: { action: "pause" } };

describe("POST /realtime/push", () => {
  it("Bearer가 없으면 401", async () => {
    const res = await push({ users: [crypto.randomUUID()], message }, null);
    expect(res.status).toBe(401);
  });

  it("Bearer가 틀리면 401", async () => {
    const res = await push({ users: [crypto.randomUUID()], message }, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("사용자가 40명을 넘으면 413", async () => {
    const users = Array.from({ length: 41 }, () => crypto.randomUUID());
    const res = await push({ users, message });
    expect(res.status).toBe(413);
    expect(await res.json()).toHaveProperty("error");
  });

  it.each([
    ["JSON이 아님", "{"],
    ["message 없음", { users: [crypto.randomUUID()] }],
    ["users 비어 있음", { users: [], message }],
    ["uuid가 아닌 사용자", { users: ["not-a-uuid"], message }],
    ["message가 객체가 아님", { users: [crypto.randomUUID()], message: "hi" }],
  ])("%s → 400", async (_, body) => {
    const res = await push(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });

  it("202를 돌려주고 구독 중인 소켓에 message를 그대로 보낸다", async () => {
    const sub = crypto.randomUUID();
    const client = await connect(`authorization.bearer.${await signToken(key, { sub })}`);
    expect(JSON.parse(await client.next()).type).toBe("connected");

    const res = await push({ users: [sub, crypto.randomUUID()], message });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2 });
    expect(JSON.parse(await client.next())).toEqual(message);
  });
});
