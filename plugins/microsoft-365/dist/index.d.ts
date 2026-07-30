export { MICROSOFT_GRAPH_PROVIDER_ID, MICROSOFT_GRAPH_SECRET_SUFFIX, MICROSOFT_GRAPH_TOOLS, MicrosoftGraphProvider, } from "./MicrosoftGraphProvider.js";
export type { MicrosoftGraphConfiguration } from "./MicrosoftGraphProvider.js";
import type { IntegrationProvider, IntegrationProviderFactoryContext } from "./host-contract.js";
export type { IntegrationConnectionSubmission, IntegrationDeviceCodeConnectResult, IntegrationInvocationContext, IntegrationLifecycleContext, IntegrationProvider, IntegrationProviderFactoryContext, IntegrationProviderPollResult, IntegrationProviderStatus, IntegrationProviderTool, IntegrationSecretStore, } from "./host-contract.js";
export { IntegrationProviderPublicError } from "./host-contract.js";
export { default as manifest } from "../.tritonai-plugin/plugin.json";
export declare function createIntegrationProvider({ secrets, configuration: input, }: IntegrationProviderFactoryContext): IntegrationProvider;
