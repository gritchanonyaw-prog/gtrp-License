import { generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** Fresh throwaway secrets for every test run. Never reuse real secrets in tests. */
function testSecrets() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    LICENSE_KEY_PEPPER: randomBytes(32).toString("base64"),
    LEASE_SIGNING_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
    MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    MOCK_PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
  };
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "../../migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            ENVIRONMENT: "test",
            APP_ORIGINS: "https://webapp.test",
            ...testSecrets(),
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      testTimeout: 30_000,
    },
  };
});
