import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * The model provider behind the assistant (DECISIONS.md ADR-122): Claude,
 * through Anthropic's SDK, with the organization's own API key. Tests use a
 * scripted stand-in; nothing else can replace the real client.
 */
export interface AssistantClient {
  /** Proves the key and model work, without spending on a message. */
  check(model: string): Promise<void>;
  create(params: MessageCreateParamsNonStreaming): Promise<BetaMessage>;
}

function anthropicClient(apiKey: string): AssistantClient {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  return {
    async check(model) {
      await client.models.retrieve(model);
    },
    create: (params) => client.beta.messages.create(params),
  };
}

let testClient: AssistantClient | null = null;

export function assistantClient(apiKey: string): AssistantClient {
  return testClient ?? anthropicClient(apiKey);
}

/** Tests only: stand in for the provider. */
export function setTestAssistantClient(client: AssistantClient | null) {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST)
    throw new Error("Test clients are for tests only");
  testClient = client;
}

/** A provider error as a short message for the settings page, without the key. */
export function describeProviderError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "The API key was refused.";
  if (error instanceof Anthropic.PermissionDeniedError)
    return "The API key may not use this model.";
  if (error instanceof Anthropic.NotFoundError) return "The model was not found for this key.";
  if (error instanceof Anthropic.RateLimitError) return "Rate limited by the provider; try later.";
  if (error instanceof Anthropic.APIConnectionError) return "Could not reach the provider.";
  if (error instanceof Anthropic.APIError) return `Provider error ${error.status ?? ""}`.trim();
  return error instanceof Error ? error.message.slice(0, 200) : "Unknown error";
}
