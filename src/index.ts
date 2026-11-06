import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import * as z from "zod";
import { authenticate, bearerProtocol } from "./auth";

export { UserHub } from "./user_hub";

const PushBody = z.object({
  users: z.array(z.uuid()).min(1).max(40),
  message: z.record(z.string(), z.unknown()),
});

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

app.get("/realtime/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  const requested = c.req.header("Sec-WebSocket-Protocol");

  let auth: { sub: string; protocol: string };
  try {
    auth = await authenticate(requested, c.env);
  } catch {
    // 핸드셰이크는 성공시키고 1008로 닫아야 브라우저가 닫힘 코드를 본다.
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.close(1008, "unauthorized");
    const protocol = bearerProtocol(requested);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : {},
    });
  }

  // `_pk` 등 쿼리는 DO로 넘기지 않는다. 101의 Sec-WebSocket-Protocol은 DO가 넣는다.
  const url = new URL(c.req.url);
  url.search = "";
  const headers = new Headers({ "X-Realtime-Protocol": auth.protocol });
  for (const [name, value] of c.req.raw.headers) {
    if (name === "upgrade" || name === "connection" || name.startsWith("sec-websocket-")) {
      headers.set(name, value);
    }
  }
  return c.env.USER_HUB.getByName(auth.sub).fetch(new Request(url, { headers }));
});

app.post(
  "/realtime/push",
  (c, next) => bearerAuth<AppEnv>({ token: c.env.PUSH_SECRET })(c, next),
  async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const parsed = PushBody.safeParse(body);
    if (!parsed.success) {
      const tooMany = parsed.error.issues.some(
        (i) => i.code === "too_big" && i.path.length === 1 && i.path[0] === "users",
      );
      return tooMany
        ? c.json({ error: "too many users" }, 413)
        : c.json({ error: "invalid body" }, 400);
    }
    const { users, message } = parsed.data;
    c.executionCtx.waitUntil(
      Promise.allSettled(users.map((u) => c.env.USER_HUB.getByName(u).deliver(message))),
    );
    return c.json({ accepted: users.length }, 202);
  },
);

export default app;
