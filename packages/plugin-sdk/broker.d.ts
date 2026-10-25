import type { JsonObject, JsonValue, PluginManifestV1 } from "./index.js";

export declare const BROKER_API_VERSION: "tritonai.plugin/v2";
export declare const BROKER_PROTOCOL: "tritonai.plugin-broker/v1";
export declare const BROKER_SDK_API_MAJOR: 2;
export declare const BROKER_HOST_CONTRACT_LEVEL: 3;
export declare const BROKER_POLICY_FORMAT: "tritonai.plugin-broker-policy/v1";
export declare const BROKER_LIMITS: Readonly<{ frameBytes: 524288; requestId: 2147483647 }>;
export interface BrokerOperation {
  readonly id: string;
  readonly tool: string;
}
export interface BrokerManifest extends Omit<
  PluginManifestV1,
  "apiVersion" | "manifestVersion" | "sdk"
> {
  readonly apiVersion: "tritonai.plugin/v2";
  readonly manifestVersion: 2;
  readonly sdk: { readonly apiMajor: 2; readonly requiredHostContractLevel: number };
  readonly broker: {
    readonly protocol: "tritonai.plugin-broker/v1";
    readonly policyId: string;
    readonly policyVersion: number;
    readonly operations: readonly BrokerOperation[];
  };
}
export interface OperationRequest {
  readonly protocol: "tritonai.plugin-broker/v1";
  readonly requestId: number;
  readonly kind: "operation";
  readonly operationId: string;
  readonly parameters: JsonObject;
}
/** Authority is the host's pipe plus active invocation, never worker-selected IDs. */
export interface OperationBroker {
  request(operationId: string, parameters: JsonObject): Promise<JsonValue>;
}
export interface BrokerProvider {
  readonly id: string;
  invoke(
    toolName: string,
    input: JsonObject,
    context: { readonly signal: AbortSignal },
  ): Promise<JsonValue>;
  close?(): Promise<void>;
}
export type CreateBrokerProvider = (context: {
  readonly configuration: JsonObject;
  readonly broker: OperationBroker;
}) => BrokerProvider;
export declare function validateBrokerManifest(value: unknown): BrokerManifest;
export declare function validateOperationRequest(value: unknown): OperationRequest;
export declare function validateBrokerPolicy(value: unknown, manifest: unknown): JsonObject;
export type OperationResponse = {
  readonly protocol: "tritonai.plugin-broker/v1";
  readonly requestId: number;
} & (
  | { readonly kind: "result"; readonly value: JsonValue }
  | {
      readonly kind: "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly outcome: "not_dispatched" | "unknown";
      };
    }
);
export declare function validateOperationResponse(value: unknown): OperationResponse;
export declare function createOperationBroker(
  transport: (request: OperationRequest) => Promise<OperationResponse>,
): OperationBroker;
