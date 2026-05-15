/**
 * server/services/features/browser-feature.ts
 *
 * Feature registration for browser control.
 *
 * The "browser" feature bundles:
 *   - The `browser` server tool (tagged with feature: "browser")
 *   - A sidecar that hosts the WebSocket server the Chrome extension connects to
 *
 * When enabled (via config or `--enable=browser` in chat mode), the tool
 * becomes visible to the LLM AND the sidecar spawns. When disabled, neither.
 *
 * One-shot `huko -- prompt` never spawns sidecars, so the tool may appear
 * in the LLM surface (if --enable=browser was passed) but browser commands
 * will fail with a clear "server not running" error.
 */

import { registerFeature } from "./registry.js";
import { startServer, stopServer } from "../../task/tools/server/browser-session.js";

registerFeature({
  name: "browser",
  enabledByDefault: false,
  sidecar: {
    async start(_deps) {
      await startServer();
    },
    async stop() {
      await stopServer();
    },
  },
});
