import { type IntegrationConnectionSubmission, type IntegrationDeviceCodeConnectResult, type IntegrationInvocationContext, type IntegrationLifecycleContext, type IntegrationProvider, type IntegrationProviderPollResult, type IntegrationProviderStatus, type IntegrationProviderTool, type IntegrationSecretStore } from "./host-contract.js";
export declare const GITHUB_PROVIDER_ID = "github";
/** Package-local suffix; Harness adds the collision-free package namespace. */
export declare const GITHUB_SECRET_SUFFIX = "github-oauth-user";
export interface GitHubConfiguration {
    readonly clientId: string;
}
export declare const GITHUB_TOOLS: readonly [IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool];
type Fetch = typeof globalThis.fetch;
export declare class GitHubProvider implements IntegrationProvider {
    #private;
    readonly id = "github";
    readonly tools: readonly [IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool, IntegrationProviderTool];
    constructor(secrets: IntegrationSecretStore, configuration: GitHubConfiguration, fetchImplementation?: Fetch, requestTimeoutMs?: number);
    status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus>;
    connect(capabilities: ReadonlyArray<string>, context?: IntegrationLifecycleContext, submission?: IntegrationConnectionSubmission): Promise<IntegrationDeviceCodeConnectResult>;
    poll(flowId: string, context?: IntegrationLifecycleContext): Promise<IntegrationProviderPollResult>;
    prepare(context?: IntegrationLifecycleContext): Promise<void>;
    disconnect(context?: IntegrationLifecycleContext): Promise<void>;
    invoke(toolName: string, input: unknown, context?: IntegrationInvocationContext): Promise<unknown>;
    close(): Promise<void>;
}
export {};
