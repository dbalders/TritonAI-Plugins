export declare const PLUGIN_API_VERSION: "tritonai.plugin/v1";
export declare const PLUGIN_KIND: "IntegrationPlugin";
export declare const PLUGIN_MANIFEST_VERSION: 1;
export declare const SDK_API_MAJOR: 1;
export declare const HOST_CONTRACT_LEVEL: 1;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonSchema = JsonObject;

export interface PluginSdkContract {
  readonly apiMajor: 1;
  readonly requiredHostContractLevel: number;
}
export interface PluginCapability {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly access: "default" | "opt-in";
}
export interface PluginTool {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly effect: "read" | "write";
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  readonly inputSchema: JsonSchema;
}
export interface PluginSkill {
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
}
export interface PluginManifestV1 {
  readonly apiVersion: "tritonai.plugin/v1";
  readonly kind: "IntegrationPlugin";
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly sdk: PluginSdkContract;
  readonly entry: string;
  readonly provider: string;
  readonly configurationSchema: JsonSchema;
  readonly capabilities: readonly PluginCapability[];
  readonly tools: readonly PluginTool[];
  readonly skills: readonly PluginSkill[];
}

export interface PluginFailure {
  readonly _tag: "PluginFailure";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}
export interface ExternalCommitOutcomeUnknown {
  readonly _tag: "ExternalCommitOutcomeUnknown";
  readonly code: "external_commit_outcome_unknown";
  readonly message: string;
  readonly retryable: false;
  readonly details?: JsonObject;
}
export type PluginBoundaryError = PluginFailure | ExternalCommitOutcomeUnknown;

/** Injected per package. Plugin code cannot address another package's secrets. */
export interface IntegrationSecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}
export interface IntegrationOperationContext {
  readonly signal: AbortSignal;
}
export interface IntegrationLifecycleContext extends IntegrationOperationContext {
  /** Admit one final externally visible lifecycle mutation, such as credential rotation. */
  beginCommit(): Promise<AbortSignal>;
}
export interface IntegrationInvocationContext extends IntegrationOperationContext {
  readonly writeApproved: boolean;
  /**
   * Crosses the host-controlled write boundary. The host rejects unapproved,
   * repeated, or post-abort calls and returns the signal for the commit phase.
   */
  beginCommit(): Promise<AbortSignal>;
}
export interface IntegrationProviderStatus extends JsonObject {
  readonly state: "not_connected" | "connecting" | "connected" | "error";
  readonly accountLabel: string | null;
  readonly grantedCapabilities: readonly string[];
  readonly message: string | null;
}
export interface IntegrationConnectionSubmission extends JsonObject {
  readonly kind: "api_key";
  readonly flowId: string;
  readonly value: string;
}
export interface IntegrationDeviceCodeConnectResult extends JsonObject {
  readonly kind: "device_code";
  readonly flowId: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string | null;
  readonly userCode: string;
  readonly message: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}
export interface IntegrationAuthorizationUrlConnectResult extends JsonObject {
  readonly kind: "authorization_url";
  readonly flowId: string;
  readonly authorizationUrl: string;
  readonly message: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}
export interface IntegrationApiKeyConnectResult extends JsonObject {
  readonly kind: "api_key";
  readonly flowId: string;
  readonly label: string;
  readonly placeholder: string | null;
  readonly message: string;
}
export interface IntegrationConnectedConnectResult extends JsonObject {
  readonly kind: "connected";
  readonly flowId: string;
  readonly message: string;
}
export type IntegrationConnectResult =
  | IntegrationDeviceCodeConnectResult
  | IntegrationAuthorizationUrlConnectResult
  | IntegrationApiKeyConnectResult
  | IntegrationConnectedConnectResult;
export interface IntegrationProviderPollResult extends JsonObject {
  readonly state: "pending" | "connected" | "expired" | "failed";
  readonly retryAfterSeconds: number | null;
  readonly message: string | null;
}
export interface IntegrationProvider {
  readonly id: string;
  status(context: IntegrationOperationContext): Promise<IntegrationProviderStatus>;
  prepare?(context: IntegrationLifecycleContext): Promise<void>;
  connect?(
    capabilities: readonly string[],
    context: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationConnectResult>;
  poll?(
    flowId: string,
    context: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResult>;
  disconnect?(context: IntegrationLifecycleContext): Promise<void>;
  invoke(
    toolName: string,
    input: JsonObject,
    context: IntegrationInvocationContext,
  ): Promise<JsonValue>;
  close?(): Promise<void>;
}
export interface IntegrationProviderFactoryContext {
  readonly secrets: IntegrationSecretStore;
  readonly configuration: JsonObject;
}
export type CreateIntegrationProvider = (
  context: IntegrationProviderFactoryContext,
) => IntegrationProvider;

export declare function canonicalJson(value: JsonValue): string;
export declare function validateManifestV1(value: unknown): PluginManifestV1;
export declare function pluginFailure(
  code: string,
  message: string,
  options?: { readonly retryable?: boolean; readonly details?: JsonObject },
): PluginFailure;
export declare function externalCommitOutcomeUnknown(
  message?: string,
  details?: JsonObject,
): ExternalCommitOutcomeUnknown;
