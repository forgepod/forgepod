import { expect, test } from "bun:test";
import { formatParams, formatReturn, typeName } from "./signature";

test("optional parameters are marked, required ones are not", () => {
  const input = {
    type: "object",
    properties: { span_m: { type: "number" }, note: { type: "string" } },
    required: ["span_m"],
  };
  expect(formatParams(input)).toBe("span_m: number, note?: string");
});

test("a tool taking nothing renders as empty, not as an object", () => {
  expect(formatParams({ type: "object" })).toBe("");
  expect(formatParams(undefined)).toBe("");
});

test("an object return is spelled out, since that is what a caller binds to", () => {
  expect(
    formatReturn({
      type: "object",
      properties: { reaction_left_kn: { type: "number" }, unit: { type: "string" } },
    }),
  ).toBe("{ reaction_left_kn: number, unit: string }");
});

test("no output schema reads as text, which is the warning it is", () => {
  expect(formatReturn(undefined)).toBe("text");
});

test("arrays, enums and unions survive", () => {
  expect(typeName({ type: "array", items: { type: "number" } })).toBe("number[]");
  expect(typeName({ enum: ["mm", "m"] })).toBe('"mm" | "m"');
  expect(typeName({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe("string | null");
  expect(typeName({})).toBe("unknown");
});
