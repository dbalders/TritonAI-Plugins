export { GOOGLE_WORKSPACE_PROVIDER_ID, GOOGLE_WORKSPACE_SECRET_SUFFIX, GOOGLE_WORKSPACE_TOOLS, GoogleWorkspaceProvider, } from "./GoogleWorkspaceProvider.js";
export type { GoogleWorkspaceConfiguration } from "./GoogleWorkspaceProvider.js";
import type { IntegrationProvider, IntegrationProviderFactoryContext } from "./host-contract.js";
export type { IntegrationAuthorizationUrlConnectResult, IntegrationConnectedConnectResult, IntegrationConnectResult, IntegrationConnectionSubmission, IntegrationInvocationContext, IntegrationLifecycleContext, IntegrationProvider, IntegrationProviderFactoryContext, IntegrationProviderPollResult, IntegrationProviderStatus, IntegrationProviderTool, IntegrationSecretStore, } from "./host-contract.js";
export { IntegrationProviderPublicError } from "./host-contract.js";
export { default as manifest } from "../.tritonai-plugin/plugin.json";
export declare function createIntegrationProvider({ secrets, configuration: input, }: IntegrationProviderFactoryContext): IntegrationProvider;
