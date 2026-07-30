export {
  GOOGLE_WORKSPACE_PROVIDER_ID,
  GOOGLE_WORKSPACE_SECRET_SUFFIX,
  GOOGLE_WORKSPACE_TOOLS,
  GoogleWorkspaceProvider,
} from "./GoogleWorkspaceProvider.js";
export type { GoogleWorkspaceConfiguration } from "./GoogleWorkspaceProvider.js";
import { GoogleWorkspaceProvider } from "./GoogleWorkspaceProvider.js";
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

function configuration(value: unknown): {
  readonly clientId: string;
  readonly clientSecret: string;
} {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error("Google Workspace configuration must be a plain object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).toSorted().join(",") !== "clientId,clientSecret" ||
    typeof record.clientId !== "string" ||
    typeof record.clientSecret !== "string"
  ) {
    throw new Error(
      "Google Workspace configuration must contain exactly clientId and clientSecret strings.",
    );
  }
  return { clientId: record.clientId, clientSecret: record.clientSecret };
}

export function createIntegrationProvider({
  secrets,
  configuration: input,
}: IntegrationProviderFactoryContext): IntegrationProvider {
  return new GoogleWorkspaceProvider(secrets, configuration(input));
}
