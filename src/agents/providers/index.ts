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

  const apiKey = env.FORGEPOD_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim();
  try {
    return anthropicProvider(apiKey ? { apiKey } : {});
  } catch {
    throw new Error(
      "No provider configured. Set FORGEPOD_BASE_URL and FORGEPOD_API_KEY for a gateway, or ANTHROPIC_API_KEY for Anthropic.",
    );
  }
}
