// Global (non-module) declaration file: types `env` and `exports` from "cloudflare:workers" in tests.
type GtrpAppEnv = import("../src/env.js").Env;

declare namespace Cloudflare {
  interface Env extends GtrpAppEnv {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
  interface GlobalProps {
    mainModule: typeof import("../src/index.js");
  }
}
