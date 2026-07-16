import * as Schema from "effect/Schema";
import { type IntegrationConnectionSubmission, type IntegrationDeviceCodeConnectResult, type IntegrationInvocationContext, type IntegrationLifecycleContext, type IntegrationProvider, type IntegrationProviderPollResult, type IntegrationProviderStatus, type IntegrationSecretStore } from "./host-contract.js";
/** Package-local suffix; the Harness adds the collision-free package namespace. */
export declare const MICROSOFT_GRAPH_SECRET_SUFFIX = "oauth";
export declare const MICROSOFT_GRAPH_PROVIDER_ID = "microsoft-graph-read";
export interface MicrosoftGraphConfiguration {
    readonly clientId: string;
    readonly tenantId: string;
}
export declare const MICROSOFT_GRAPH_TOOLS: readonly [{
    readonly name: "microsoft365.mail.search";
    readonly description: "Search Microsoft 365 mail through the fixed read-only messages endpoint with bounded input and output.";
    readonly input: Schema.Struct<{
        readonly query: Schema.optionalKey<Schema.String>;
        readonly limit: Schema.optionalKey<Schema.Int>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}, {
    readonly name: "microsoft365.calendar.events";
    readonly description: "Read Microsoft 365 calendar events through the fixed calendar-view endpoint in a bounded timestamp range.";
    readonly input: Schema.Struct<{
        readonly start: Schema.optionalKey<Schema.String>;
        readonly end: Schema.optionalKey<Schema.String>;
    }>;
    readonly readOnly: true;
    readonly destructive: false;
    readonly idempotent: true;
    readonly openWorld: true;
}];
type Fetch = typeof globalThis.fetch;
export declare class MicrosoftGraphProvider implements IntegrationProvider {
    #private;
    readonly id = "microsoft-graph-read";
    readonly tools: readonly [{
        readonly name: "microsoft365.mail.search";
        readonly description: "Search Microsoft 365 mail through the fixed read-only messages endpoint with bounded input and output.";
        readonly input: Schema.Struct<{
            readonly query: Schema.optionalKey<Schema.String>;
            readonly limit: Schema.optionalKey<Schema.Int>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }, {
        readonly name: "microsoft365.calendar.events";
        readonly description: "Read Microsoft 365 calendar events through the fixed calendar-view endpoint in a bounded timestamp range.";
        readonly input: Schema.Struct<{
            readonly start: Schema.optionalKey<Schema.String>;
            readonly end: Schema.optionalKey<Schema.String>;
        }>;
        readonly readOnly: true;
        readonly destructive: false;
        readonly idempotent: true;
        readonly openWorld: true;
    }];
    constructor(secrets: IntegrationSecretStore, configuration: MicrosoftGraphConfiguration, fetchImplementation?: Fetch, requestTimeoutMs?: number);
    status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus>;
    connect(capabilities: ReadonlyArray<string>, context?: IntegrationLifecycleContext, submission?: IntegrationConnectionSubmission): Promise<IntegrationDeviceCodeConnectResult>;
    poll(flowId: string, context?: IntegrationLifecycleContext): Promise<IntegrationProviderPollResult>;
    prepare(context?: IntegrationLifecycleContext): Promise<void>;
    disconnect(context?: IntegrationLifecycleContext): Promise<void>;
    invoke(toolName: string, input: unknown, context?: IntegrationInvocationContext): Promise<unknown>;
    close(): Promise<void>;
}
export {};
