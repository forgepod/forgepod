import OpenAI from "openai";
import type { Exchange, Provider, SendArgs, Turn } from "../provider";

export type OpenAICompatibleOptions = {
  apiKey?: string;
  baseURL: string;
  fetch?: typeof fetch;
  name?: string;
};

type AssistantMessage = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;

function toMessages(system: string, history: Exchange[]) {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (system) messages.push({ role: "system", content: system });

  for (const entry of history) {
    if (entry.role === "user") {
      messages.push({ role: "user", content: entry.text });
    } else if (entry.role === "assistant") {
      messages.push(entry.raw as AssistantMessage);
    } else {
      // Each result is its own message here, unlike Anthropic where they share one.
      for (const result of entry.results) {
        messages.push({ role: "tool", tool_call_id: result.id, content: result.content });
      }
    }
  }

  return messages;
}

export function openAICompatibleProvider(options: OpenAICompatibleOptions): Provider {
  const client = new OpenAI({
    apiKey: options.apiKey || "not-needed",
    baseURL: options.baseURL,
    fetch: options.fetch,
    maxRetries: 0,
  });

  return {
    name: options.name ?? "openai-compatible",
    async send(
      { model, system, history, tools }: SendArgs,
      onDelta?: (text: string) => void,
    ): Promise<Turn> {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: toMessages(system, history),
        // No max token cap is sent: this talks to gateways whose ceilings and parameter
        // names differ, and their own default is the one that is always accepted.
        tools: tools.length
          ? tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema as Record<string, unknown>,
              },
            }))
          : undefined,
      };

      const completion = onDelta
        ? await streamed(client, params, onDelta)
        : await client.chat.completions.create(params);

      const choice = completion.choices[0];
      const message = choice?.message;
      const calls = message?.tool_calls ?? [];

      return {
        text: message?.content ? [message.content] : [],
        toolCalls: calls.flatMap((call) => {
          if (call.type !== "function") return [];
          return [
            {
              id: call.id,
              name: call.function.name,
              // Arguments arrive as a JSON string, never as an object.
              input: parseArguments(call.function.arguments),
            },
          ];
        }),
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
        },
        raw: message,
        done: choice?.finish_reason !== "tool_calls",
      };
    },
  };
}

/**
 * The SDK helper accumulates the fragments, which matters for tool calls: arguments
 * arrive split across deltas and indexed, and reassembling them by hand is the part
 * that goes subtly wrong.
 */
function streamed(
  client: OpenAI,
  params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "stream">,
  onDelta: (text: string) => void,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const stream = client.chat.completions.stream({
    ...params,
    // A gateway that ignores this reports no token counts while streaming. One that
    // rejects it says so plainly, which is better than silence.
    stream_options: { include_usage: true },
  });
  stream.on("content.delta", (event) => onDelta(event.delta));
  return stream.finalChatCompletion();
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
