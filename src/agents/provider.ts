/**
 * The seam between the agent loop and whoever answers it. It stays deliberately thin:
 * the loop never learns a provider's message format, and a provider never learns what a
 * run is.
 */
export type ToolSpec = { name: string; description: string; inputSchema: unknown };
export type ToolCall = { id: string; name: string; input: unknown };
export type ToolOutcome = { id: string; content: string; isError: boolean };

/**
 * An assistant turn is carried as `raw`, the provider's own representation, and handed
 * straight back on the next request. Normalising it would drop whatever the provider
 * needs to keep its own continuity, which for Claude means thinking blocks.
 */
export type Exchange =
  | { role: "user"; text: string }
  | { role: "assistant"; raw: unknown }
  | { role: "tool_results"; results: ToolOutcome[] };

export type Turn = {
  text: string[];
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  raw: unknown;
  done: boolean;
};

export type SendArgs = {
  model: string;
  system: string;
  history: Exchange[];
  tools: ToolSpec[];
};

/**
 * `onDelta` is what streaming costs the seam: one optional callback rather than a
 * second method, so the loop reads the same either way and an adapter that cannot
 * stream simply ignores it.
 */
export interface Provider {
  readonly name: string;
  send(args: SendArgs, onDelta?: (text: string) => void): Promise<Turn>;
}
