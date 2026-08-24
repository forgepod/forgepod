/**
 * Renders the JSON Schema a plugin publishes as a function signature, which is the
 * form the operator already reads tools in. Nothing here talks to a plugin, so it
 * stays a pure function and stays testable.
 */
export type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
};

export function typeName(schema?: Schema): string {
  if (!schema) return "unknown";
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(typeName).join(" | ");

  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
  if (type === "array") return `${typeName(schema.items)}[]`;
  if (type === "object") {
    const props = Object.entries(schema.properties ?? {});
    if (props.length === 0) return "object";
    return `{ ${props.map(([k, v]) => `${k}: ${typeName(v)}`).join(", ")} }`;
  }
  return type ?? "unknown";
}

/** Optional parameters are marked, since that is the difference a caller acts on. */
export function formatParams(schema?: Schema): string {
  const props = Object.entries(schema?.properties ?? {});
  if (props.length === 0) return "";
  const required = new Set(schema?.required ?? []);
  return props.map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${typeName(v)}`).join(", ");
}

/** No output schema means the tool answers with text a caller has to parse. */
export function formatReturn(schema?: Schema): string {
  return schema ? typeName(schema) : "text";
}
