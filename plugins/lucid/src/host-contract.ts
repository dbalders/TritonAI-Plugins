import type {
  IntegrationAuthorizationUrlConnectResult,
  IntegrationConnectedConnectResult,
  IntegrationConnectionSubmission,
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationOperationContext,
  IntegrationProvider,
  IntegrationProviderPollResult,
  IntegrationProviderStatus,
  IntegrationSecretStore,
  JsonObject,
  JsonValue,
} from "@tritonai/plugin-sdk";

export type {
  IntegrationAuthorizationUrlConnectResult,
  IntegrationConnectedConnectResult,
  IntegrationConnectionSubmission,
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationOperationContext,
  IntegrationProvider,
  IntegrationProviderPollResult,
  IntegrationProviderStatus,
  IntegrationSecretStore,
  JsonObject,
  JsonValue,
};

/** A sanitized failure whose message may reach the user and the agent. */
export class IntegrationProviderPublicError extends Error {
  readonly _tag = "PluginFailure";
  readonly code = "lucid_operation_failed";
  readonly retryable = false;

  constructor(message: string) {
    super(message.trim() || "Lucid operation failed.");
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
