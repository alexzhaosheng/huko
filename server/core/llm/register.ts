/**
 * server/core/llm/register.ts
 *
 * Side-effect module. Importing `server/core/llm` triggers this file,
 * which in turn registers every built-in protocol adapter with the
 * registry.
 *
 * Adding a new protocol:
 *   1. Drop the adapter file under `./adapters/`.
 *   2. Add one `registerAdapter(...)` line below.
 *
 * No other file needs to change.
 */

import { registerAdapter } from "./protocol.js";
import { openaiAdapter } from "./adapters/openai.js";

registerAdapter(openaiAdapter);
