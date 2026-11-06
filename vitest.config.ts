import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          JWKS_URL: "https://auth.test/.well-known/jwks.json",
          JWT_ISSUER: "https://auth.test/",
          JWT_AUDIENCE: "https://api.test",
          PUSH_SECRET: "test-push-secret",
        },
      },
    }),
  ],
});
