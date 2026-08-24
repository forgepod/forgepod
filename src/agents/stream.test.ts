import { expect, test } from "bun:test";
import { appendText, readEvents, type StreamEvent } from "./stream";

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of readEvents(bodyOf(chunks))) events.push(event);
  return events;
}

test("an event split across two chunks still arrives whole", async () => {
  const events = await collect([
    'data: {"kind":"delta","te',
    'xt":"Left support "}\n\n',
    'data: {"kind":"delta","text":"carries 6.67 kN."}\n\n',
  ]);

  expect(events).toEqual([
    { kind: "delta", text: "Left support " },
    { kind: "delta", text: "carries 6.67 kN." },
  ]);
});

test("several events in one chunk all arrive, in order", async () => {
  const events = await collect([
    'data: {"kind":"tool_call","tool":"t","input":{}}\n\ndata: {"kind":"done","error":null}\n\n',
  ]);

  expect(events.map((e) => e.kind)).toEqual(["tool_call", "done"]);
});

test("a trailing frame with no blank line is not emitted half-parsed", async () => {
  const events = await collect(['data: {"kind":"delta","text":"a"}\n\ndata: {"kind":"del']);
  expect(events).toEqual([{ kind: "delta", text: "a" }]);
});

test("a multi-byte character straddling chunks is not corrupted", async () => {
  const encoder = new TextEncoder();
  const full = encoder.encode('data: {"kind":"delta","text":"13.33 kNm →"}\n\n');
  const events: StreamEvent[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split inside the arrow's three bytes.
      controller.enqueue(full.slice(0, full.length - 6));
      controller.enqueue(full.slice(full.length - 6));
      controller.close();
    },
  });
  for await (const event of readEvents(body)) events.push(event);

  expect(events).toEqual([{ kind: "delta", text: "13.33 kNm →" }]);
});

test("deltas grow the open text block, and a tool call closes it", () => {
  let live = appendText([], "Left ");
  live = appendText(live, "support");
  expect(live).toEqual([{ kind: "text", text: "Left support" }]);

  live = [...live, { kind: "tool_call", tool: "t", input: {} }];
  live = appendText(live, "carries 6.67 kN.");
  expect(live).toEqual([
    { kind: "text", text: "Left support" },
    { kind: "tool_call", tool: "t", input: {} },
    { kind: "text", text: "carries 6.67 kN." },
  ]);
});
