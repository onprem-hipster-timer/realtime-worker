// 배포 환경이 넣는 값(deploy.yml의 --var와 wrangler secret put). wrangler.jsonc에 없으므로
// `wrangler types`가 만들지 않는다. 전역 Env(hono Bindings)와 cloudflare:workers의 env 양쪽에 붙인다.
interface DeployEnv {
  JWKS_URL: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  PUSH_SECRET: string;
}

interface Env extends DeployEnv {}

declare namespace Cloudflare {
  interface Env extends DeployEnv {}
}
