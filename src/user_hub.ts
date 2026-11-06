import { DurableObject } from "cloudflare:workers";

const SOCKET_TTL_MS = 24 * 3600 * 1000;

type Attachment = { exp: number };

// 사용자당 하나. Worker가 JWT를 검증한 뒤에만 연결을 넘긴다.
export class UserHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const protocol = request.headers.get("X-Realtime-Protocol");
      if (!protocol) return new Response(null, { status: 400 });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ exp: Date.now() + SOCKET_TTL_MS } satisfies Attachment);
      server.send(
        JSON.stringify({
          id: crypto.randomUUID(),
          type: "connected",
          from_user: null,
          timestamp: new Date().toISOString(),
          payload: {},
        }),
      );
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { "Sec-WebSocket-Protocol": protocol },
      });
    } catch (err) {
      console.error("user_hub_connect_failed", err);
      return new Response(null, { status: 500 });
    }
  }

  async deliver(message: Record<string, unknown>): Promise<number> {
    const data = JSON.stringify(message);
    const now = Date.now();
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const { exp } = ws.deserializeAttachment() as Attachment;
        if (now >= exp) {
          ws.close(4000, "reconnect");
          continue;
        }
        ws.send(data);
        sent++;
      } catch (err) {
        console.warn("user_hub_send_failed", err);
      }
    }
    return sent;
  }

  // 클라이언트 메시지는 `ping`뿐이고 자동 응답이 처리한다. 나머지는 무시.
  async webSocketMessage() {}

  async webSocketClose(_ws: WebSocket, code: number) {
    console.debug("user_hub_close", code);
  }

  async webSocketError(_ws: WebSocket, error: unknown) {
    console.debug("user_hub_error", error);
  }
}
