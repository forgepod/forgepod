import { expect, test } from "bun:test";
import type { Exchange, ToolSpec } from "./provider";
import { anthropicProvider, openAICompatibleProvider, providerFromEnv } from "./providers";

const ZEN = "https://opencode.ai/zen/v1";

const tools: ToolSpec[] = [
  {
    name: "beam-mcp__beam_reactions",
    description: "Support reactions.",
    inputSchema: { type: "object", properties: { span_m: { type: "number" } }, required: ["span_m"] },
  },
];

function capturing(body: unknown) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { seen, stub };
}

test("the gateway provider posts chat completions and reads back a tool call", async () => {
  const { seen, stub } = capturing({
    id: "cmpl_1",
    object: "chat.completion",
    model: "claude-sonnet-4-6",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "beam-mcp__beam_reactions",
                arguments: '{"span_m":6,"load_kn":10}',
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 812, completion_tokens: 44 },
  });

  const provider = openAICompatibleProvider({ baseURL: ZEN, apiKey: "k", fetch: stub });
  const turn = await provider.send({
    model: "claude-sonnet-4-6",
    system: "Be exact.",
    history: [{ role: "user", text: "6 m span" }],
    tools,
  });

  expect(seen[0]?.url).toBe(`${ZEN}/chat/completions`);
  expect(seen[0]?.body.messages).toEqual([
    { role: "system", content: "Be exact." },
    { role: "user", content: "6 m span" },
  ]);
  expect(seen[0]?.body.tools).toMatchObject([
    { type: "function", function: { name: "beam-mcp__beam_reactions" } },
  ]);

  expect(turn.done).toBe(false);
  // Arguments arrive as a JSON string on this API and must not reach the tool that way.
  expect(turn.toolCalls).toEqual([
    { id: "call_1", name: "beam-mcp__beam_reactions", input: { span_m: 6, load_kn: 10 } },
  ]);
  expect(turn.usage).toEqual({ inputTokens: 812, outputTokens: 44 });
});

test("the gateway provider replays tool results as separate tool messages", async () => {
  const { seen, stub } = capturing({
    id: "cmpl_2",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "6.67 kN." } }],
    usage: { prompt_tokens: 900, completion_tokens: 12 },
  });

  const history: Exchange[] = [
    { role: "user", text: "6 m span" },
    { role: "assistant", raw: { role: "assistant", content: null, tool_calls: [] } },
    { role: "tool_results", results: [{ id: "call_1", content: '{"reaction_left_kn":6.67}', isError: false }] },
  ];

  const provider = openAICompatibleProvider({ baseURL: ZEN, apiKey: "k", fetch: stub });
  const turn = await provider.send({ model: "m", system: "", history, tools: [] });

  expect(seen[0]?.body.messages).toEqual([
    { role: "user", content: "6 m span" },
    { role: "assistant", content: null, tool_calls: [] },
    { role: "tool", tool_call_id: "call_1", content: '{"reaction_left_kn":6.67}' },
  ]);
  expect(turn.done).toBe(true);
  expect(turn.text).toEqual(["6.67 kN."]);
});

test("the anthropic provider replays tool results inside one user message", async () => {
  const { seen, stub } = capturing({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "6.67 kN." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 12 },
  });

  const provider = anthropicProvider({ apiKey: "k", fetch: stub });
  await provider.send({
    model: "claude-opus-5",
    system: "",
    history: [
      { role: "user", text: "6 m span" },
      { role: "assistant", raw: [{ type: "text", text: "checking" }] },
      { role: "tool_results", results: [{ id: "toolu_1", content: "{}", isError: true }] },
    ],
    tools: [],
  });

  expect(seen[0]?.body.messages).toEqual([
    { role: "user", content: "6 m span" },
    { role: "assistant", content: [{ type: "text", text: "checking" }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}", is_error: true }],
    },
  ]);
});

test("a base url selects the gateway, and its absence selects anthropic", () => {
  expect(
    providerFromEnv({ FORGEPOD_BASE_URL: ZEN, FORGEPOD_API_KEY: "k" }).name,
  ).toBe("openai-compatible");

  expect(providerFromEnv({ ANTHROPIC_API_KEY: "k" }).name).toBe("anthropic");

  expect(() => providerFromEnv({ FORGEPOD_BASE_URL: ZEN })).toThrow(
    /FORGEPOD_API_KEY/,
  );
});
