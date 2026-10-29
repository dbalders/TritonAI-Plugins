import {
  type IntegrationAuthorizationUrlConnectResult,
  type IntegrationConnectedConnectResult,
  type IntegrationConnectionSubmission,
  type IntegrationInvocationContext,
  type IntegrationLifecycleContext,
  type IntegrationOperationContext,
  type IntegrationProvider,
  IntegrationProviderPublicError,
  type IntegrationProviderPollResult,
  type IntegrationProviderStatus,
  type IntegrationSecretStore,
  type JsonObject,
  type JsonValue,
} from "./host-contract.js";
import {
  N8N_PROVIDER_ID,
  N8N_SERVICE_ENVIRONMENTS,
  N8N_TOOLS,
  N8nProvider,
  type N8nServiceEnvironment,
  n8nCredentialSecretName,
} from "./N8nProvider.js";

type Fetch = typeof globalThis.fetch;

const UNKNOWN_ENVIRONMENT_MESSAGE = "This n8n environment is not available in this plugin version.";
const SWITCHED_ENVIRONMENT_MESSAGE =
  "n8n switched environments while this request was starting, so it was not run. Try again.";

/**
 * Routes each host operation to the n8n deployment the user selected in Harness. Every deployment
 * keeps its own provider, sign-in flows, session, and secrets, so switching never signs the user
 * out of the other one. Hosts that predate service environments omit the selection; those calls
 * use Prod, the first environment, exactly as earlier releases did.
 */
export class N8nEnvironmentProvider implements IntegrationProvider {
  readonly id = N8N_PROVIDER_ID;
  readonly tools = N8N_TOOLS;
  readonly #secrets: IntegrationSecretStore;
  readonly #providers: ReadonlyMap<string, N8nProvider>;
  #activeEnvironmentId: string | undefined;

  constructor(
    secrets: IntegrationSecretStore,
    configuration: { readonly serverUrl: string },
    fetchImplementation?: Fetch,
    requestTimeoutMs?: number,
  ) {
    if (configuration.serverUrl !== N8N_SERVICE_ENVIRONMENTS[0].serverUrl) {
      throw new Error("n8n configuration must contain only the reviewed server URL.");
    }
    this.#secrets = secrets;
    this.#providers = new Map(
      N8N_SERVICE_ENVIRONMENTS.map((environment) => [
        environment.id,
        new N8nProvider(
          secrets,
          { serverUrl: environment.serverUrl },
          fetchImplementation,
          requestTimeoutMs,
        ),
      ]),
    );
  }

  #environment(context?: IntegrationOperationContext): N8nServiceEnvironment {
    const selected = context?.serviceEnvironment;
    if (selected === undefined) return N8N_SERVICE_ENVIRONMENTS[0];
    const environment = N8N_SERVICE_ENVIRONMENTS.find(({ id }) => id === selected);
    if (!environment) throw new IntegrationProviderPublicError(UNKNOWN_ENVIRONMENT_MESSAGE);
    return environment;
  }

  /**
   * The host sends operations for the selected environment only, so the environment of the latest
   * operation is the one in use. Every operation cancels sign-ins still pending in the others (they
   * were abandoned by switching; stored credentials stay), including one that finished starting
   * after the switch. Work that would act on an environment the user has since left is refused
   * before it starts, unless it only reads status.
   */
  async #enter(
    environment: N8nServiceEnvironment,
    options: { readonly current: boolean },
  ): Promise<N8nProvider> {
    this.#activeEnvironmentId = environment.id;
    await Promise.allSettled(
      [...this.#providers]
        .filter(([id]) => id !== environment.id)
        .map(([, provider]) => provider.cancelPendingSignIn()),
    );
    if (options.current && this.#activeEnvironmentId !== environment.id) {
      throw new IntegrationProviderPublicError(SWITCHED_ENVIRONMENT_MESSAGE);
    }
    return this.#providers.get(environment.id)!;
  }

  #provider(context?: IntegrationOperationContext): Promise<N8nProvider> {
    return this.#enter(this.#environment(context), { current: true });
  }

  /** A stored credential is a cheap hint that the user can switch back without signing in. */
  async #signedInElsewhere(
    selected: N8nServiceEnvironment,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<N8nServiceEnvironment>> {
    const signedIn: N8nServiceEnvironment[] = [];
    for (const environment of N8N_SERVICE_ENVIRONMENTS) {
      if (environment.id === selected.id) continue;
      if (signal?.aborted) break;
      try {
        if ((await this.#secrets.get(n8nCredentialSecretName(environment))) !== null) {
          signedIn.push(environment);
        }
      } catch {
        // The note is informational. The selected environment's own status stays authoritative.
      }
    }
    return signedIn;
  }

  async status(context?: IntegrationOperationContext): Promise<IntegrationProviderStatus> {
    let environment: N8nServiceEnvironment;
    try {
      environment = this.#environment(context);
    } catch {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: UNKNOWN_ENVIRONMENT_MESSAGE,
      };
    }
    const status = await (await this.#enter(environment, { current: false })).status(context);
    if (status.state === "error") return status;
    const others = await this.#signedInElsewhere(environment, context?.signal);
    if (others.length === 0) return status;
    const names = others.map(({ displayName }) => displayName).join(" and ");
    const note =
      status.state === "connected" ? `Also signed in to ${names}.` : `Still signed in to ${names}.`;
    return { ...status, message: status.message ? `${status.message} ${note}` : note };
  }

  async prepare(context?: IntegrationLifecycleContext): Promise<void> {
    return (await this.#provider(context)).prepare(context);
  }

  async connect(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationAuthorizationUrlConnectResult | IntegrationConnectedConnectResult> {
    const environment = this.#environment(context);
    const provider = await this.#enter(environment, { current: true });
    const result = await provider.connect(capabilities, context, submission);
    // A switch that landed while this sign-in was registering abandoned it. Close it now; the
    // result's flow then reports "not found" when polled instead of staying open until it expires.
    if (this.#activeEnvironmentId !== environment.id) await provider.cancelPendingSignIn();
    return result;
  }

  async poll(
    flowId: string,
    context?: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResult> {
    return (await this.#provider(context)).poll(flowId, context);
  }

  async disconnect(context?: IntegrationLifecycleContext): Promise<void> {
    return (await this.#provider(context)).disconnect(context);
  }

  async invoke(
    toolName: string,
    input: JsonObject,
    context?: IntegrationInvocationContext,
  ): Promise<JsonValue> {
    return (await this.#provider(context)).invoke(toolName, input, context);
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#providers.values()].map((provider) => provider.close()),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
