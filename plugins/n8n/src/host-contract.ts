import type {
  IntegrationAuthorizationUrlConnectResult,
  IntegrationConnectedConnectResult,
  IntegrationConnectionSubmission,
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationProviderPollResult,
  IntegrationProviderStatus,
  IntegrationSecretStore,
  JsonObject,
  JsonValue,
} from "@tritonai/plugin-sdk";
import type * as Schema from "effect/Schema";

export type {
  IntegrationAuthorizationUrlConnectResult,
  IntegrationConnectedConnectResult,
  IntegrationConnectionSubmission,
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationProviderPollResult,
  IntegrationProviderStatus,
  IntegrationSecretStore,
  JsonObject,
  JsonValue,
};

export class IntegrationProviderPublicError extends Error {
  readonly _tag = "PluginFailure";
  readonly code = "n8n_operation_failed";
  readonly retryable = false;

  constructor(message: string) {
    super(message.trim() || "n8n operation failed.");
    this.name = "PluginFailure";
  }
}

export class ExternalCommitOutcomeUnknownError extends Error {
  readonly _tag = "ExternalCommitOutcomeUnknown";
  readonly code = "external_commit_outcome_unknown";
  readonly retryable = false;

  constructor(message = "The external commit may have completed. Do not retry automatically.") {
    super(message);
    this.name = "ExternalCommitOutcomeUnknown";
  }
}

export interface IntegrationProviderTool {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Decoder<unknown>;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
}

export interface IntegrationProvider {
  readonly id: string;
  readonly tools: ReadonlyArray<IntegrationProviderTool>;
  status(context?: { readonly signal: AbortSignal }): Promise<IntegrationProviderStatus>;
  prepare?(context?: IntegrationLifecycleContext): Promise<void>;
  connect?(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationAuthorizationUrlConnectResult | IntegrationConnectedConnectResult>;
  poll?(
    flowId: string,
    context?: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResult>;
  disconnect?(context?: IntegrationLifecycleContext): Promise<void>;
  invoke(
    toolName: string,
    input: JsonObject,
    context?: IntegrationInvocationContext,
  ): Promise<JsonValue>;
  close?(): Promise<void>;
}
