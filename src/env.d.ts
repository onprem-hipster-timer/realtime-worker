// PUSH_SECRET은 `wrangler secret put`으로 넣는 값이라 `wrangler types`가 만들지 않는다.
interface Env {
  PUSH_SECRET: string;
}
