import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

/**
 * Narrow structural boundary matching TritonAI Harness PR #74 at
 * 33a0b5087981142209ccaa0a317c5baa9e4d35be. The Harness does not yet export a
 * provider SDK, so its build composition must prove this assignment against
 * IntegrationRegistry.ts when it pins and bundles this source package.
 */
export interface IntegrationInvocationContext {
  readonly signal: AbortSignal;
}

export interface IntegrationLifecycleContext extends IntegrationInvocationContext {
  beginCommit(): Promise<AbortSignal>;
}

export interface IntegrationConnectionSubmission {
  readonly flowId: string;
  readonly value: string;
}

export interface IntegrationDeviceCodeConnectResult {
  readonly kind: "device_code";
  readonly flowId: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string | null;
  readonly userCode: string;
  readonly message: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

export interface IntegrationProviderPollResult {
  readonly state: "pending" | "connected" | "expired" | "failed";
  readonly retryAfterSeconds: number | null;
  readonly message: string | null;
}

export interface IntegrationProviderStatus {
  readonly state: "not_connected" | "connecting" | "connected" | "error";
  readonly accountLabel: string | null;
  readonly grantedCapabilities: ReadonlyArray<string>;
  readonly message: string | null;
}

export class IntegrationProviderPublicError extends Error {
  readonly _tag = "IntegrationProviderPublicError";

  constructor(message: string) {
    super(message.trim() || "Integration provider operation failed.");
    this.name = "IntegrationProviderPublicError";
  }
}

export interface IntegrationProviderTool {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Decoder<unknown>;
  readonly readOnly: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly openWorld: boolean;
}

export interface IntegrationProvider {
  readonly id: string;
  readonly tools: ReadonlyArray<IntegrationProviderTool>;
  status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus>;
  connect?(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationDeviceCodeConnectResult>;
  poll?(
    flowId: string,
    context?: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResult>;
  disconnect?(context?: IntegrationLifecycleContext): Promise<void>;
  invoke(
    toolName: string,
    input: unknown,
    context?: IntegrationInvocationContext,
  ): Promise<unknown>;
  close?(): Promise<void>;
}

/** The host injects its already package-scoped Effect secret-store facade. */
export interface IntegrationSecretStore {
  get(name: string): Effect.Effect<Option.Option<Uint8Array>, unknown>;
  set(name: string, value: Uint8Array): Effect.Effect<void, unknown>;
  remove(name: string): Effect.Effect<void, unknown>;
}
