/**
 * Reading the run stream. This lives outside the component because the framing is the
 * part that breaks quietly: one event can arrive split across two chunks, and the join
 * only shows up as a dropped tool call rather than an error.
 */
export type StreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; tool: string; input: unknown }
  | { kind: "tool_result"; tool: string; output: unknown; isError: boolean }
  | { kind: "done"; runId: string | null; error: string | null };

export type LiveStep =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; tool: string; input: unknown }
  | { kind: "tool_result"; tool: string; output: unknown; isError: boolean };

export async function* readEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // A multi-byte character can straddle two chunks, so the decoder keeps state.
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as StreamEvent;
      boundary = buffer.indexOf("\n\n");
    }
  }
}

/** Deltas belong to whichever text block is still being written. */
export function appendText(current: LiveStep[], text: string): LiveStep[] {
  const last = current[current.length - 1];
  if (last?.kind === "text") {
    return [...current.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...current, { kind: "text", text }];
}
