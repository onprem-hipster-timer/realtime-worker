# realtime-worker

타이머 실시간 전달의 **호스팅 모드** 메시지 서버입니다. Cloudflare Worker가 연결을 인증하고, 사용자마다 하나인 Durable Object(`UserHub`, Hibernation)가 소켓을 들고 있다가 backend가 보낸 메시지를 전달합니다.

- 명령·접근 판정·상태는 backend(Python)가 결정합니다. 이 Worker는 인증과 전달만 합니다.
- **온프렘 배포에는 필요 없습니다.** backend 기본값 `REALTIME_BACKEND=inprocess`는 프로세스 안의 WebSocket(`/v1/ws/timers`)으로 같은 계약을 제공합니다.
- 소유 범위: 이 Worker의 스크립트·route·시크릿은 wrangler가 관리합니다. Terraform(`infra`)은 backend 쪽 env와 `realtime-push-secret`만 관리합니다.

## 계약

### 1. WebSocket 연결 — `GET /realtime/ws`

- 인증: `Sec-WebSocket-Protocol: authorization.bearer.<Kratos JWT>`. 다른 서브프로토콜과 함께 보내도 됩니다.
- 검증: `JWKS_URL`의 키로 `ES256`, `iss = JWT_ISSUER`, `aud = JWT_AUDIENCE`, `sub`·`exp` 필수. JWT는 연결할 때만 검증합니다.
- 성공: `101`, `Sec-WebSocket-Protocol`에 요청한 `authorization.bearer.<jwt>` 항목을 한 번 그대로 돌려줍니다. 첫 메시지는 `connected`입니다.
  ```json
  {"id": "<uuid>", "type": "connected", "from_user": null, "timestamp": "<ISO 8601>", "payload": {}}
  ```
- 실패: 핸드셰이크는 `101`로 받고 곧바로 `1008 unauthorized`로 닫습니다(브라우저가 닫힘 코드를 볼 수 있게).
- 클라이언트 → 서버는 문자열 `ping`뿐이고 서버는 `pong`으로 답합니다. 그 외 메시지는 무시합니다.
- 소켓 수명은 24시간입니다. 지난 소켓은 다음 전달 때 `4000 reconnect`로 닫으므로 클라이언트는 바로 다시 연결합니다.
- 쿼리 문자열(`?_pk=` 등)은 Durable Object로 넘기지 않습니다. `Upgrade: websocket`이 없으면 `426`, 그 외 경로는 `404`입니다.

### 2. push — `POST /realtime/push` (backend → Worker)

- `Authorization: Bearer <PUSH_SECRET>` (hono `bearerAuth`, 상수 시간 비교). 없거나 틀리면 `401`, Bearer 형식이 아니면 `400`.
- 본문: `{"users": ["<sub uuid>", …], "message": {…봉투…}}`. `users`는 1~40명.
- 응답: 형식 오류 `400 {"error"}`, 41명 이상 `413 {"error"}`, 정상 `202 {"accepted": <명수>}`.
- `202`는 접수만 뜻합니다. 전달은 응답 뒤 `waitUntil`로 사용자별 `UserHub.deliver()`가 하고, `message`를 JSON 그대로 보냅니다. 놓친 메시지는 클라이언트가 (재)연결 직후 REST로 다시 맞춥니다.

### 3. 설정

| 이름 | 종류 | 설명 |
| --- | --- | --- |
| `JWKS_URL` | var | backend의 `GET /auth/.well-known/jwks.json` |
| `JWT_ISSUER` | var | Kratos JWT의 `iss` |
| `JWT_AUDIENCE` | var | Kratos JWT의 `aud` |
| `PUSH_SECRET` | secret | backend `REALTIME_PUSH_SECRET`과 같은 값 |
| `routes` | wrangler.jsonc | `<api_host>/realtime/*` |

`wrangler.jsonc`의 `routes`와 `vars`는 `api.example.com` 자리표시자입니다. 배포하기 전에 실제 호스트와 zone으로 바꿔 커밋합니다(자리표시자 그대로면 배포가 실패합니다). 같은 호스트의 custom domain보다 route가 우선하므로 `/realtime/*`만 이 Worker로 옵니다.

## 로컬 실행

```bash
npm ci
npx wrangler types          # worker-configuration.d.ts 생성 (커밋하지 않음)
echo 'PUSH_SECRET=dev-secret' > .dev.vars
npm run dev                 # wrangler dev
```

로컬 backend의 JWKS를 쓰려면 vars를 덮어씁니다.

```bash
npx wrangler dev --var JWKS_URL:http://localhost:8000/auth/.well-known/jwks.json \
  --var JWT_ISSUER:<iss> --var JWT_AUDIENCE:<aud>
```

검사: `npm run check` (typecheck → vitest).

## 배포

`main`에 push하면 `.github/workflows/deploy.yml`이 `npm run check` 뒤 `cloudflare/wrangler-action@v4`로 `wrangler deploy`를 실행합니다.

1. 레포 시크릿: `CLOUDFLARE_API_TOKEN`(Edit Cloudflare Workers 템플릿 + Zone 권한 Workers Routes 편집), `CLOUDFLARE_ACCOUNT_ID`.
2. `wrangler.jsonc`의 `routes`·`vars`를 실제 값으로 바꿉니다.
3. 첫 배포 뒤 1회, 운영자가 `npx wrangler secret put PUSH_SECRET`. 설정 전에는 모든 push가 `401`입니다.

JWKS 키 회전: jose는 JWKS를 isolate마다 10분 캐시하고, 모르는 `kid`를 만나면 다시 받습니다. 다만 마지막으로 받은 지 30초 안이면 다시 받지 않고 `1008`로 닫습니다(클라이언트는 1008에서 재연결을 멈춥니다). 그래서 새 키는 서명에 쓰기 **전에** JWKS에 게시해 두고(backend 응답의 `Cache-Control: max-age=3600`을 고려해 1시간 이상), 옛 키는 그 키로 서명한 토큰이 만료될 때까지 남겨 둡니다.

## 의존성

- 런타임 의존성은 `jose`(JWT 검증), `hono`(라우터, `hono/bearer-auth`), `zod`(push 본문) 세 개다. 버전은 exact pin이고 설치는 `npm ci`만 쓴다.
- zod는 `import * as z from "zod"`로 가져온다. `import { z } from "zod"`는 로케일 전체가 번들에 들어간다.
