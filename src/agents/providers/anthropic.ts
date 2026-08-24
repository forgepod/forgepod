import Anthropic from "@anthropic-ai/sdk";
import type { Exchange, Provider, SendArgs, Turn } from "../provider";

export type AnthropicOptions = { apiKey?: string; baseURL?: string; fetch?: typeof fetch };

const toMessages = (history: Exchange[]): Anthropic.MessageParam[] =>
  history.map((entry) => {
    if (entry.role === "user") return { role: "user", content: entry.text };
    if (entry.role === "assistant") {
      return { role: "assistant", content: entry.raw as Anthropic.ContentBlockParam[] };
    }
    return {
      role: "user",
      content: entry.results.map((result) => ({
        type: "tool_result" as const,
        tool_use_id: result.id,
        content: result.content,
        is_error: result.isError,
      })),
    };
  });

export function anthropicProvider(options: AnthropicOptions = {}): Provider {
  const client = new Anthropic(options);

  return {
    name: "anthropic",
    async send({ model, system, history, tools }: SendArgs): Promise<Turn> {
      const response = await client.messages.create({
        model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system,
        messages: toMessages(history),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
        })),
      });

      return {
        text: response.content.filter((b) => b.type === "text").map((b) => b.text),
        toolCalls: response.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input })),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        // The whole turn goes back, thinking blocks included, because dropping them
        // breaks the model's own continuity.
        raw: response.content,
        done: response.stop_reason !== "tool_use",
      };
    },
  };
}
