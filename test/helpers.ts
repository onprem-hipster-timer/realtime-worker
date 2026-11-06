import { env, exports } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { vi } from "vitest";

export const PUSH_SECRET = "test-push-secret"; // vitest.config.ts와 같은 값

export type SigningKey = { kid: string; privateKey: CryptoKey };

// 테스트가 JWKS_URL로 서빙하는 키 목록. 앞에 넣을수록 새 키(회전).
export const jwks: { keys: JWK[] } = { keys: [] };

export async function addSigningKey(kid: string): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  jwks.keys.unshift({ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" });
  return { kid, privateKey };
}

// Worker·DO는 테스트와 같은 isolate에서 돌므로 전역 fetch를 바꾸면 jose의 JWKS 요청도 여기로 온다.
export function serveJwks() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== env.JWKS_URL) throw new Error(`unexpected fetch: ${url}`);
    return Response.json(jwks);
  });
}

export function signToken(
  key: SigningKey,
  claims: { sub?: string; iss?: string; aud?: string; exp?: number | string } = {},
) {
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: key.kid })
    .setIssuedAt()
    .setIssuer(claims.iss ?? env.JWT_ISSUER)
    .setAudience(claims.aud ?? env.JWT_AUDIENCE)
    .setExpirationTime(claims.exp ?? "10m");
  if (claims.sub) jwt.setSubject(claims.sub);
  return jwt.sign(key.privateKey);
}

export type Client = {
  res: Response;
  ws: WebSocket;
  next(): Promise<string>;
  closed: Promise<CloseEvent>;
};

export async function connect(protocol?: string, path = "/realtime/ws"): Promise<Client> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (protocol) headers["Sec-WebSocket-Protocol"] = protocol;
  const res = await exports.default.fetch(`https://api.test${path}`, { headers });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket (status ${res.status})`);

  const queue: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const data = e.data as string;
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else queue.push(data);
  });
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve));
  ws.accept();
  return {
    res,
    ws,
    next: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise<string>((resolve) => waiters.push(resolve)),
    closed,
  };
}

export function push(body: unknown, token: string | null = PUSH_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return exports.default.fetch("https://api.test/realtime/push", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
