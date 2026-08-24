import type { Provider } from "../provider";
import { anthropicProvider } from "./anthropic";
import { openAICompatibleProvider } from "./openai-compatible";

export { anthropicProvider } from "./anthropic";
export { openAICompatibleProvider } from "./openai-compatible";

/**
 * One switch decides the provider: set a base URL and the install talks to an
 * OpenAI-compatible gateway, leave it unset and it talks to Anthropic directly. Keys
 * belong to whoever runs the install and are never stored in the database.
 */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): Provider {
  const baseURL = env.FORGEPOD_BASE_URL?.trim();

  if (baseURL) {
    const apiKey = env.FORGEPOD_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("FORGEPOD_BASE_URL is set but FORGEPOD_API_KEY is not.");
    }
    return openAICompatibleProvider({ baseURL, apiKey });
  }

  // Checked here rather than left to the SDK. The client constructs without
  // credentials and only fails at request time, and by then the operator gets the
  // SDK's wording instead of the two variable names that would fix it. A server has
  // no CLI login profile to fall back on either.
  const apiKey = env.FORGEPOD_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "No provider configured. Set ANTHROPIC_API_KEY, or set FORGEPOD_BASE_URL and FORGEPOD_API_KEY to use a gateway.",
    );
  }

  return anthropicProvider({ apiKey });
}
