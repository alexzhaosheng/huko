# LLM Layer

> `server/core/llm/` adapts provider protocols into one internal turn result.

See [architecture.md](../architecture.md) for cross-module principles.

## Files

```text
server/core/llm/
  types.ts              shared LLM types
  protocol.ts           adapter contract
  register.ts           adapter registry
  invoke.ts             public invocation entry point
  xml-tools.ts          XML-style tool prompt helpers
  adapters/openai.ts    OpenAI-compatible adapter
  providers/            provider presets such as OpenRouter
```

## Contract

Adapters normalize provider-specific behavior into:

- Text deltas.
- Final assistant content.
- Parsed tool calls.
- Usage counters.
- Protocol-level errors.

The task pipeline should not need to know whether a provider is OpenAI, OpenRouter, or another compatible endpoint.

## Tool-Call Modes

huko supports provider-native tool calls where available and XML/tool-in-text style prompts where needed. Both routes produce the same internal `ToolCall` shape.

## Registration

Adapters are registered explicitly. Public invocation functions import the registrar as a side effect so consumers do not need to remember setup order.

## Streaming

Streaming should be token-level when the provider supports it. The LLM layer emits deltas; persistence and frontend delivery are handled by the pipeline and session context.

## Pitfalls

- Do not leak provider-specific response objects past this layer.
- Do not include private entry metadata such as `_entryId` in messages sent to providers.
- Do not assume all providers support native tool calls.
- Do not make adapters read project config directly; pass resolved config in.

## Verification

```bash
npm run check
npm test
```

Use provider-specific demo scripts only when credentials are configured.

## See Also

- [pipeline.md](./pipeline.md)
- [tools.md](./tools.md)
- [config.md](./config.md)
