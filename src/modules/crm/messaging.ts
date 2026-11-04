import "server-only";
import type { CampaignChannel } from "./campaign-rules";

/**
 * Where campaign messages are handed to a provider (DECISIONS.md ADR-119).
 * No provider adapter is included yet: one is added — with its connector,
 * sealed credentials and delivery receipts — only once it has been tested
 * against the provider with real credentials. Until then no channel is
 * connected and campaigns cannot be launched.
 */

export interface OutgoingMessage {
  to: string;
  subject?: string;
  text: string;
}

export interface MessagingProvider {
  /** Shown to the user, e.g. "Unifonic". */
  name: string;
  send(message: OutgoingMessage): Promise<{ providerMessageId: string }>;
}

const testProviders = new Map<string, MessagingProvider>();

/** The provider connected for an organization's channel, or null. */
export async function providerFor(
  organizationId: string,
  channel: CampaignChannel,
): Promise<MessagingProvider | null> {
  return testProviders.get(`${organizationId}:${channel}`) ?? null;
}

/** Tests only: stand in a provider for one organization and channel. */
export function setTestProvider(
  organizationId: string,
  channel: CampaignChannel,
  provider: MessagingProvider | null,
) {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST)
    throw new Error("Test providers are for tests only");
  if (provider) testProviders.set(`${organizationId}:${channel}`, provider);
  else testProviders.delete(`${organizationId}:${channel}`);
}
