import { env, exports } from "cloudflare:workers";
import { SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { UserHub } from "../src/user_hub";
import { addSigningKey, connect, serveJwks, signToken, type SigningKey } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let fetchSpy: MockInstance<typeof fetch>;
let key: SigningKey;

beforeAll(async () => {
  fetchSpy = serveJwks();
  key = await addSigningKey("k1");
});

afterEach(() => {
  vi.useRealTimers();
});

async function bearer(claims: Parameters<typeof signToken>[1], signer = key) {
  return `authorization.bearer.${await signToken(signer, claims)}`;
}

async function connectAs(sub: string) {
  const protocol = await bearer({ sub });
  return { ...(await connect(protocol)), protocol };
}

describe("GET /realtime/ws", () => {
  it("올바른 JWT면 101에 서브프로토콜을 한 번 그대로 돌려주고 connected를 먼저 보낸다", async () => {
    const { res, protocol, next } = await connectAs(crypto.randomUUID());

    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe(protocol);

    const first = JSON.parse(await next());
    expect(first).toMatchObject({ type: "connected", from_user: null, payload: {} });
    expect(first.id).toMatch(UUID);
    expect(new Date(first.timestamp).toISOString()).toBe(first.timestamp);
  });

  it("다른 서브프로토콜이 섞여 있으면 bearer 항목만 돌려준다", async () => {
    const protocol = await bearer({ sub: crypto.randomUUID() });
    const { res } = await connect(`chat, ${protocol}`);

    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe(protocol);
  });

  it.each([
    ["HS256 서명", () => new SignJWT({ sub: crypto.randomUUID() })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(env.JWT_ISSUER)
      .setAudience(env.JWT_AUDIENCE)
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("x".repeat(32)))
      .then((t) => `authorization.bearer.${t}`)],
    ["만료", () => bearer({ sub: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) - 60 })],
    ["aud 불일치", () => bearer({ sub: crypto.randomUUID(), aud: "https://other.test" })],
    ["iss 불일치", () => bearer({ sub: crypto.randomUUID(), iss: "https://other.test/" })],
    ["sub 없음", () => bearer({})],
    ["형식 오류", async () => "authorization.bearer.not-a-jwt"],
  ])("%s → 101 후 1008로 닫는다", async (_, makeProtocol) => {
    const protocol = await makeProtocol();
    const { res, closed } = await connect(protocol);

    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe(protocol);
    expect((await closed).code).toBe(1008);
  });

  it("서브프로토콜이 없으면 1008로 닫는다", async () => {
    const { res, closed } = await connect(undefined);

    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBeNull();
    expect((await closed).code).toBe(1008);
  });

  it("Upgrade 헤더가 없으면 426", async () => {
    const res = await exports.default.fetch("https://api.test/realtime/ws");
    expect(res.status).toBe(426);
  });

  it("쿼리(_pk 등)는 DO로 넘기지 않는다", async () => {
    const hubFetch = vi.spyOn(UserHub.prototype, "fetch");
    const protocol = await bearer({ sub: crypto.randomUUID() });

    const { res } = await connect(protocol, "/realtime/ws?_pk=attacker&x=1");

    expect(res.status).toBe(101);
    expect(hubFetch).toHaveBeenCalledOnce();
    const forwarded = hubFetch.mock.calls[0][0];
    expect(new URL(forwarded.url).search).toBe("");
    expect(forwarded.headers.get("X-Realtime-Protocol")).toBe(protocol);
    hubFetch.mockRestore();
  });

  it("/parties/* 는 404", async () => {
    const res = await exports.default.fetch("https://api.test/parties/user-hub/someone", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
  });

  it("ping 문자열에는 pong으로 자동 응답한다", async () => {
    const { ws, next } = await connectAs(crypto.randomUUID());
    await next(); // connected

    ws.send("ping");
    expect(await next()).toBe("pong");
  });
});

describe("UserHub.deliver", () => {
  it("사용자마다 다른 허브로 가고 그 사용자의 소켓에만 전달한다", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const a1 = await connectAs(a);
    const a2 = await connectAs(a);
    const b1 = await connectAs(b);
    await Promise.all([a1.next(), a2.next(), b1.next()]); // connected

    expect(await env.USER_HUB.getByName(a).deliver({ to: "a" })).toBe(2);
    expect(JSON.parse(await a1.next())).toEqual({ to: "a" });
    expect(JSON.parse(await a2.next())).toEqual({ to: "a" });

    expect(await env.USER_HUB.getByName(b).deliver({ to: "b" })).toBe(1);
    expect(JSON.parse(await b1.next())).toEqual({ to: "b" });
  });

  it("24시간이 지난 소켓은 다음 전달 때 4000으로 닫는다", async () => {
    const sub = crypto.randomUUID();
    const { next, closed } = await connectAs(sub);
    await next(); // connected

    vi.setSystemTime(Date.now() + 24 * 3600 * 1000 + 1000);
    expect(await env.USER_HUB.getByName(sub).deliver({ late: true })).toBe(0);

    const event = await closed;
    expect(event.code).toBe(4000);
    expect(event.reason).toBe("reconnect");
  });
});

describe("JWKS", () => {
  it("kid가 다른 새 키를 앞에 추가하면 쿨다운(30초) 뒤 다시 받아 검증한다", async () => {
    const rotated = await addSigningKey("k2");
    const fetchesBefore = fetchSpy.mock.calls.length;

    vi.setSystemTime(Date.now() + 31_000);
    const newKey = await connect(await bearer({ sub: crypto.randomUUID() }, rotated));
    const oldKey = await connect(await bearer({ sub: crypto.randomUUID() }, key));

    expect(newKey.res.status).toBe(101);
    expect(JSON.parse(await newKey.next()).type).toBe("connected");
    expect(JSON.parse(await oldKey.next()).type).toBe("connected");
    expect(fetchSpy.mock.calls.length).toBe(fetchesBefore + 1);
  });
});
