export { GITHUB_PROVIDER_ID, GITHUB_SECRET_SUFFIX, GITHUB_TOOLS, GitHubProvider, } from "./GitHubProvider.js";
export type { GitHubConfiguration } from "./GitHubProvider.js";
import type { IntegrationProvider, IntegrationProviderFactoryContext } from "./host-contract.js";
export type { IntegrationConnectionSubmission, IntegrationDeviceCodeConnectResult, IntegrationInvocationContext, IntegrationLifecycleContext, IntegrationProvider, IntegrationProviderFactoryContext, IntegrationProviderPollResult, IntegrationProviderStatus, IntegrationProviderTool, IntegrationSecretStore, } from "./host-contract.js";
export { IntegrationProviderPublicError } from "./host-contract.js";
export { default as manifest } from "../.tritonai-plugin/plugin.json";
export declare function createIntegrationProvider({ secrets, configuration: input, }: IntegrationProviderFactoryContext): IntegrationProvider;
