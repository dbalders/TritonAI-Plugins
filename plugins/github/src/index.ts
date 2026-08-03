export {
  GITHUB_PROVIDER_ID,
  GITHUB_SECRET_SUFFIX,
  GITHUB_TOOLS,
  GitHubProvider,
} from "./GitHubProvider.js";
export type { GitHubConfiguration } from "./GitHubProvider.js";
import { GitHubProvider } from "./GitHubProvider.js";
import type { GitHubConfiguration } from "./GitHubProvider.js";
import type { IntegrationProvider, IntegrationProviderFactoryContext } from "./host-contract.js";
export type {
  IntegrationConnectionSubmission,
  IntegrationDeviceCodeConnectResult,
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

function configuration(value: unknown): GitHubConfiguration {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error("GitHub configuration must be a plain object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).toSorted().join(",") !== "clientId" ||
    typeof record.clientId !== "string"
  ) {
    throw new Error("GitHub configuration must contain exactly one public clientId string.");
  }
  return { clientId: record.clientId };
}

export function createIntegrationProvider({
  secrets,
  configuration: input,
}: IntegrationProviderFactoryContext): IntegrationProvider {
  return new GitHubProvider(secrets, configuration(input));
}
