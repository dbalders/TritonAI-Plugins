export { N8N_PROVIDER_ID, N8N_SECRET_SUFFIX, N8N_TOOLS, N8nProvider } from "./N8nProvider.js";
export type { N8nConfiguration } from "./N8nProvider.js";
import { N8nProvider } from "./N8nProvider.js";
import type { IntegrationProvider, IntegrationProviderFactoryContext } from "./host-contract.js";
export type {
  IntegrationAuthorizationUrlConnectResult,
  IntegrationConnectedConnectResult,
  IntegrationConnectResult,
  IntegrationConnectionSubmission,
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationProvider,
  IntegrationProviderFactoryContext,
  IntegrationProviderPollResult,
  IntegrationProviderStatus,
  IntegrationProviderTool,
  IntegrationSecretStore,
} from "./host-contract.js";
export { IntegrationProviderPublicError } from "./host-contract.js";
export { default as manifest } from "../.tritonai-plugin/plugin.json" with { type: "json" };

function configuration(value: unknown): { readonly serverUrl: string } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error("n8n configuration must be a plain object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).toSorted().join(",") !== "serverUrl" ||
    typeof record.serverUrl !== "string"
  ) {
    throw new Error("n8n configuration must contain exactly one serverUrl string.");
  }
  return { serverUrl: record.serverUrl };
}

export function createIntegrationProvider({
  secrets,
  configuration: input,
}: IntegrationProviderFactoryContext): IntegrationProvider {
  return new N8nProvider(secrets, configuration(input));
}
