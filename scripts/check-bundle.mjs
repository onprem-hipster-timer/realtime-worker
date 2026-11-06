// `wrangler deploy --dry-run --outdir dist` 결과에 쓰지 않기로 한 모듈이 들어갔는지 검사한다.
// import 경로(`hono/jwt`)는 번들에 남지 않으므로 esbuild가 남기는 `// node_modules/...` 경로 주석도 본다.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const FORBIDDEN = [
  "routePartykitRequest",
  "hono/jwt",
  "serveStatic",
  "hono/jsx",
  "cors(",
  "hono/dist/middleware/jwt/",
  "hono/dist/middleware/jwk/",
  "hono/dist/jsx/",
];

const files = readdirSync("dist").filter((f) => f.endsWith(".js"));
if (files.length === 0) {
  console.error("dist/*.js 없음: 먼저 wrangler deploy --dry-run --outdir dist");
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const code = readFileSync(join("dist", file), "utf8");
  const gzip = gzipSync(code).length;
  console.log(`${file}: ${(code.length / 1024).toFixed(1)} KiB (gzip ${(gzip / 1024).toFixed(1)} KiB)`);
  const hono = [...code.matchAll(/^\/\/ node_modules\/hono\/dist\/(\S+)$/gm)].map((m) => m[1]);
  console.log(`  hono 모듈 ${hono.length}개: ${hono.join(", ")}`);
  for (const pattern of FORBIDDEN) {
    if (code.includes(pattern)) {
      console.error(`  금지 패턴 발견: ${pattern}`);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
