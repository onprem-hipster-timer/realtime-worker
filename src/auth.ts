import { createRemoteJWKSet, jwtVerify } from "jose";

const PREFIX = "authorization.bearer.";

// isolate마다 URL별로 하나. jose가 JWKS를 캐시하고(10분) 모르는 kid면 다시 받는다(30초 쿨다운).
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(url: string) {
  let getter = jwksByUrl.get(url);
  if (!getter) {
    getter = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, getter);
  }
  return getter;
}

// Sec-WebSocket-Protocol 목록에서 `authorization.bearer.<jwt>` 항목을 그대로 돌려준다.
export function bearerProtocol(header: string | null | undefined): string | undefined {
  return header
    ?.split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith(PREFIX));
}

export async function authenticate(
  header: string | null | undefined,
  env: Env,
): Promise<{ sub: string; protocol: string }> {
  const protocol = bearerProtocol(header);
  if (!protocol) throw new Error("missing bearer protocol");
  const { payload } = await jwtVerify(protocol.slice(PREFIX.length), jwks(env.JWKS_URL), {
    algorithms: ["ES256"],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    requiredClaims: ["sub", "exp"],
  });
  return { sub: payload.sub!, protocol };
}
