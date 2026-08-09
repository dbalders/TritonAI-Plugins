import { type IntegrationAuthorizationUrlConnectResult, type IntegrationConnectionSubmission, type IntegrationInvocationContext, type IntegrationLifecycleContext, type IntegrationProvider, type IntegrationProviderPollResult, type IntegrationProviderStatus, type IntegrationProviderTool, type IntegrationSecretStore } from "./host-contract.js";
export declare const N8N_PROVIDER_ID = "n8n";
export declare const N8N_SECRET_SUFFIX = "oauth";
export interface N8nConfiguration {
    readonly serverUrl: string;
}
export declare const N8N_TOOLS: ReadonlyArray<IntegrationProviderTool>;
type Fetch = typeof globalThis.fetch;
export declare class N8nProvider implements IntegrationProvider {
    #private;
    readonly id = "n8n";
    readonly tools: readonly IntegrationProviderTool[];
    constructor(secrets: IntegrationSecretStore, configuration: N8nConfiguration, fetchImplementation?: Fetch, requestTimeoutMs?: number);
    status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus>;
    connect(capabilities: ReadonlyArray<string>, context?: IntegrationLifecycleContext, submission?: IntegrationConnectionSubmission): Promise<IntegrationAuthorizationUrlConnectResult | {
        readonly kind: "connected";
        readonly flowId: string;
        readonly message: string;
    }>;
    poll(flowId: string, context?: IntegrationLifecycleContext): Promise<IntegrationProviderPollResult>;
    prepare(context?: IntegrationLifecycleContext): Promise<void>;
    disconnect(context?: IntegrationLifecycleContext): Promise<void>;
    invoke(toolName: string, input: unknown, context?: IntegrationInvocationContext): Promise<unknown>;
    close(): Promise<void>;
}
export {};
