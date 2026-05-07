/**
 * scripts/llm-demo.ts
 *
 * Minimal smoke test for the LLM layer.
 *
 * Sends a streaming request to OpenRouter, prints content tokens as they
 * arrive, and finally prints the assembled result + token usage.
 *
 * Optional second turn: if MODEL supports native tools, exercise the
 * tool-call path with a tiny fake tool (no execution — we just check
 * that the call comes back parsed).
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... npx tsx scripts/llm-demo.ts
 *   OPENROUTER_API_KEY=sk-or-... MODEL=openai/gpt-4o-mini npx tsx scripts/llm-demo.ts
 */

import { invoke, withOpenRouter, type Tool } from "../server/core/llm/index.js";

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY in your env first.");
  process.exit(1);
}

const model = process.env["MODEL"] ?? "anthropic/claude-3.5-haiku";

async function turn1Stream() {
  console.log(`\n── streaming turn (${model}) ──`);
  let tokens = 0;
  const result = await invoke(
    withOpenRouter({
      apiKey: apiKey!,
      model,
      messages: [
        { role: "system", content: "You are concise. Two sentences max." },
        { role: "user", content: "What is the difference between weaving and knitting?" },
      ],
      tools: [],
      toolCallMode: "native",
      onPartial: (e) => {
        if (e.type === "content") {
          process.stdout.write(e.delta);
          tokens++;
        } else if (e.type === "thinking") {
          process.stdout.write(`\x1b[2m${e.delta}\x1b[0m`);
        }
      },
    }),
  );
  console.log(`\n── done: ${tokens} content events, ${result.usage.totalTokens} tokens ──`);
}

async function turn2NativeTool() {
  console.log(`\n── native tool-call turn ──`);
  const tools: Tool[] = [
    {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name, e.g. 'Beijing'." },
        },
        required: ["city"],
      },
    },
  ];

  const result = await invoke(
    withOpenRouter({
      apiKey: apiKey!,
      model,
      messages: [{ role: "user", content: "What's the weather in Shanghai right now?" }],
      tools,
      toolCallMode: "native",
    }),
  );

  console.log("content :", JSON.stringify(result.content));
  console.log("calls   :", JSON.stringify(result.toolCalls, null, 2));
  console.log("usage   :", result.usage);
}

async function turn3XmlTool() {
  console.log(`\n── xml tool-call turn ──`);
  const tools: Tool[] = [
    {
      name: "echo",
      description: "Echo a message back.",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ];

  const result = await invoke(
    withOpenRouter({
      apiKey: apiKey!,
      model,
      messages: [{ role: "user", content: "Use the echo tool to say hello." }],
      tools,
      toolCallMode: "xml",
    }),
  );

  console.log("content :", JSON.stringify(result.content));
  console.log("calls   :", JSON.stringify(result.toolCalls, null, 2));
}

await turn1Stream();
await turn2NativeTool();
await turn3XmlTool();
