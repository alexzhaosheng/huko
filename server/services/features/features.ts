/**
 * server/services/features/features.ts
 *
 * Side-effect manifest for feature registrations.
 * Importing this module triggers registration of every built-in feature
 * — the same pattern as `server/task/tools/index.ts` for tools.
 *
 * Adding a new feature: create the file under ./services/features/,
 * then add one `import "./..."` line below.
 */

import "./browser-feature.js";
