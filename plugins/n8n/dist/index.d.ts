export { N8N_PROVIDER_ID, N8N_SECRET_SUFFIX, N8N_TOOLS, N8nProvider } from "./N8nProvider.js";
export type { N8nConfiguration } from "./N8nProvider.js";
import type { IntegrationProvider, IntegrationProviderFactoryContext } from "./host-contract.js";
export type { IntegrationAuthorizationUrlConnectResult, IntegrationConnectedConnectResult, IntegrationConnectResult, IntegrationConnectionSubmission, IntegrationInvocationContext, IntegrationLifecycleContext, IntegrationProvider, IntegrationProviderFactoryContext, IntegrationProviderPollResult, IntegrationProviderStatus, IntegrationProviderTool, IntegrationSecretStore, } from "./host-contract.js";
export { IntegrationProviderPublicError } from "./host-contract.js";
export { default as manifest } from "../.tritonai-plugin/plugin.json";
export declare function createIntegrationProvider({ secrets, configuration: input, }: IntegrationProviderFactoryContext): IntegrationProvider;
