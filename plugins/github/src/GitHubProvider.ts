import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type IntegrationConnectionSubmission,
  type IntegrationDeviceCodeConnectResult,
  type IntegrationInvocationContext,
  type IntegrationLifecycleContext,
  type IntegrationProvider,
  IntegrationProviderPublicError,
  type IntegrationProviderPollResult,
  type IntegrationProviderStatus,
  type IntegrationProviderTool,
  type IntegrationSecretStore,
} from "./host-contract.js";

export const GITHUB_PROVIDER_ID = "github";
/** Package-local suffix; Harness adds the collision-free package namespace. */
export const GITHUB_SECRET_SUFFIX = "github-oauth-user";
const LEGACY_GITHUB_APP_SECRET_SUFFIX = "github-app-user";

const GITHUB_WEB_ORIGIN = "https://github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";
const DEVICE_CODE_URL = `${GITHUB_WEB_ORIGIN}/login/device/code`;
const TOKEN_URL = `${GITHUB_WEB_ORIGIN}/login/oauth/access_token`;
const API_VERSION = "2026-03-10";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const AUTH_RESPONSE_BYTES = 64 * 1024;
const API_RESPONSE_BYTES = 2 * 1024 * 1024;
const CONTENT_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOKEN_CHARS = 2_048;
const MAX_BODY_CHARS = 65_536;
const MAX_COMMIT_MESSAGE_CHARS = 4_096;
const REQUIRED_OAUTH_SCOPES = ["repo", "read:org", "workflow"] as const;
const REQUIRED_OAUTH_SCOPE = REQUIRED_OAUTH_SCOPES.join(" ");
const CAPABILITY_NAMES = new Set([
  "identity.read",
  "repository.read",
  "repository.write",
  "issues.write",
  "pull-requests.write",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface GitHubConfiguration {
  readonly clientId: string;
}

const Owner = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u),
).annotate({ description: "Exact GitHub account or organization login." });
const Repo = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/u),
).annotate({ description: "Exact GitHub repository name." });
const PositiveId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const IssueNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));
const Page = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }));
const REF_PATTERN =
  /^(?!\/|.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*(?:~|\^|:|\?|\*|\[|\\))(?!.*\p{Cc})(?!.*\s)[^/]+(?:\/[^/]+)*$/u;
const Ref = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.isPattern(REF_PATTERN),
).annotate({ description: "Exact branch, tag, or commit ref without a refs/ prefix." });
const ShaOrRef = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.isPattern(REF_PATTERN),
).annotate({ description: "Exact commit SHA, branch, or tag." });
const PULL_HEAD_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?:)?(?!\/)(?!.*(?:^|[/:])\.{1,2}(?:\/|$))(?!.*(?:~|\^|:|\?|\*|\[|\\))(?!.*\p{Cc})(?!.*\s)[^/]+(?:\/[^/]+)*$/u;
const PullHead = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(356),
  Schema.isPattern(PULL_HEAD_PATTERN),
).annotate({ description: "Exact branch or owner-qualified fork branch." });
const FilePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\p{Cc})[^/]+(?:\/[^/]+)*$/u),
).annotate({ description: "Exact repository-relative file path; directories are not returned." });
const Query = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?!\s*$)[^:\p{Cc}]+$/u),
).annotate({ description: "Bounded free-text search terms; qualifiers are not accepted." });
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Body = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BODY_CHARS));
const OptionalBody = Schema.String.check(Schema.isMaxLength(MAX_BODY_CHARS));
const CommitMessage = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_COMMIT_MESSAGE_CHARS),
);
const FileContent = Schema.String.check(Schema.isMaxLength(MAX_FILE_BYTES));
const GitObjectSha = Schema.String.check(
  Schema.isMinLength(40),
  Schema.isMaxLength(40),
  Schema.isPattern(/^[0-9a-f]{40}$/u),
).annotate({ description: "Exact Git object SHA." });
const Label = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[^,\p{Cc}]+$/u),
).annotate({ description: "Exact label name; commas are not accepted." });
const Login = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const Labels = Schema.Array(Label).check(Schema.isMaxLength(20));
const Assignees = Schema.Array(Login).check(Schema.isMaxLength(10));

const ownerRepo = { owner: Owner, repo: Repo } as const;
const pagination = { limit: Schema.optionalKey(Limit), page: Schema.optionalKey(Page) } as const;
const EmptyInput = Schema.Record(Schema.String, Schema.Never);
const RepositoriesListInput = Schema.Struct(pagination);
const RepositoryGetInput = Schema.Struct(ownerRepo);
const RepositoryForkInput = Schema.Struct(ownerRepo);
const BranchCreateInput = Schema.Struct({ ...ownerRepo, branch: Ref, fromRef: ShaOrRef });
const RepositorySearchInput = Schema.Struct({ query: Query, ...pagination });
const ContentsGetInput = Schema.Struct({
  ...ownerRepo,
  path: FilePath,
  ref: Schema.optionalKey(Ref),
});
const ContentsPutInput = Schema.Struct({
  ...ownerRepo,
  path: FilePath,
  branch: Ref,
  message: CommitMessage,
  content: FileContent,
  sha: Schema.optionalKey(GitObjectSha),
});
const CodeSearchInput = Schema.Struct({ ...ownerRepo, query: Query, ...pagination });
const IssuesListInput = Schema.Struct({
  ...ownerRepo,
  state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])),
  labels: Schema.optionalKey(Labels),
  ...pagination,
});
const IssuesSearchInput = Schema.Struct({ ...ownerRepo, query: Query, ...pagination });
const NumberInput = Schema.Struct({ ...ownerRepo, number: IssueNumber });
const NumberPageInput = Schema.Struct({ ...ownerRepo, number: IssueNumber, ...pagination });
const IssueCreateInput = Schema.Struct({
  ...ownerRepo,
  title: Title,
  body: Schema.optionalKey(OptionalBody),
  labels: Schema.optionalKey(Labels),
  assignees: Schema.optionalKey(Assignees),
});
const IssueUpdateInput = Schema.Struct({
  ...ownerRepo,
  number: IssueNumber,
  title: Schema.optionalKey(Title),
  body: Schema.optionalKey(OptionalBody),
  state: Schema.optionalKey(Schema.Literals(["open", "closed"])),
  labels: Schema.optionalKey(Labels),
  assignees: Schema.optionalKey(Assignees),
});
const CommentCreateInput = Schema.Struct({ ...ownerRepo, number: IssueNumber, body: Body });
const PullsListInput = Schema.Struct({
  ...ownerRepo,
  state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])),
  base: Schema.optionalKey(Ref),
  head: Schema.optionalKey(Ref),
  ...pagination,
});
const PullCreateInput = Schema.Struct({
  ...ownerRepo,
  title: Title,
  body: Schema.optionalKey(OptionalBody),
  head: PullHead,
  base: Ref,
  draft: Schema.optionalKey(Schema.Boolean),
});
const ReviewCreateInput = Schema.Struct({
  ...ownerRepo,
  number: IssueNumber,
  event: Schema.Literals(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  body: Body,
});
const ActionsRunsListInput = Schema.Struct({
  ...ownerRepo,
  branch: Schema.optionalKey(Ref),
  status: Schema.optionalKey(
    Schema.Literals([
      "completed",
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "stale",
      "success",
      "timed_out",
      "in_progress",
      "queued",
      "requested",
      "waiting",
      "pending",
    ]),
  ),
  ...pagination,
});
const RunInput = Schema.Struct({ ...ownerRepo, runId: PositiveId });
const JobsInput = Schema.Struct({ ...ownerRepo, runId: PositiveId, ...pagination });
const CommitInput = Schema.Struct({ ...ownerRepo, ref: ShaOrRef, ...pagination });
const CommitStatusInput = Schema.Struct({ ...ownerRepo, ref: ShaOrRef });

type Decoder = Schema.Decoder<unknown>;
const tool = (
  name: string,
  description: string,
  input: Decoder,
  readOnly = true,
  destructive = false,
): IntegrationProviderTool => ({
  name,
  description,
  input,
  readOnly,
  destructive,
  idempotent: readOnly,
  openWorld: true,
});

export const GITHUB_TOOLS = [
  tool("github.identity.get", "Read the connected GitHub account through GET /user.", EmptyInput),
  tool(
    "github.repositories.list",
    "List bounded repositories accessible to the authenticated GitHub user.",
    RepositoriesListInput,
  ),
  tool("github.repositories.get", "Read one exact repository.", RepositoryGetInput),
  tool(
    "github.repositories.fork",
    "Fork one repository into the authenticated user's personal account.",
    RepositoryForkInput,
    false,
  ),
  tool(
    "github.branches.create",
    "Create one branch from an existing commit, branch, or tag in the same repository.",
    BranchCreateInput,
    false,
  ),
  tool(
    "github.repositories.search",
    "Search repositories with a bounded GitHub search query.",
    RepositorySearchInput,
  ),
  tool(
    "github.contents.get",
    "Read one exact repository file no larger than one megabyte.",
    ContentsGetInput,
  ),
  tool(
    "github.contents.put",
    "Create or update one bounded UTF-8 repository file and commit it to an existing branch.",
    ContentsPutInput,
    false,
    true,
  ),
  tool("github.code.search", "Search code in one exact repository.", CodeSearchInput),
  tool(
    "github.issues.list",
    "List bounded issues and pull-request issue records in one repository.",
    IssuesListInput,
  ),
  tool(
    "github.issues.search",
    "Search issues and pull requests in one exact repository.",
    IssuesSearchInput,
  ),
  tool("github.issues.get", "Read one exact issue or pull-request issue record.", NumberInput),
  tool(
    "github.issues.comments.list",
    "List bounded conversation comments for one issue or pull request.",
    NumberPageInput,
  ),
  tool("github.issues.create", "Create one bounded issue.", IssueCreateInput, false),
  tool(
    "github.issues.update",
    "Narrowly update one issue without deleting it.",
    IssueUpdateInput,
    false,
    true,
  ),
  tool(
    "github.issues.comment.create",
    "Add one bounded comment to an issue.",
    CommentCreateInput,
    false,
  ),
  tool("github.pulls.list", "List bounded pull requests in one repository.", PullsListInput),
  tool("github.pulls.get", "Read one exact pull request.", NumberInput),
  tool(
    "github.pulls.reviews.list",
    "List bounded review metadata for one pull request.",
    NumberPageInput,
  ),
  tool(
    "github.pulls.review-comments.list",
    "List bounded inline review comments for one pull request.",
    NumberPageInput,
  ),
  tool(
    "github.pulls.create",
    "Create a pull request between existing refs; never writes git objects.",
    PullCreateInput,
    false,
  ),
  tool(
    "github.pulls.comment.create",
    "Add one bounded conversation comment to a pull request.",
    CommentCreateInput,
    false,
  ),
  tool(
    "github.pulls.review.create",
    "Submit one review without inline comments.",
    ReviewCreateInput,
    false,
  ),
  tool("github.actions.runs.list", "List bounded workflow-run metadata.", ActionsRunsListInput),
  tool("github.actions.run.get", "Read one exact workflow run.", RunInput),
  tool("github.actions.jobs.list", "List bounded jobs and steps for one workflow run.", JobsInput),
  tool(
    "github.commits.check-runs.list",
    "List bounded check runs for one exact commit ref.",
    CommitInput,
  ),
  tool(
    "github.commits.status.get",
    "Read the combined commit status for one exact ref.",
    CommitStatusInput,
  ),
] as const satisfies ReadonlyArray<IntegrationProviderTool>;

interface Account {
  readonly login: string;
  readonly id: number;
}
interface Credential {
  readonly version: 2;
  readonly accessToken: string;
  readonly oauthScopes: ReadonlyArray<string>;
  readonly account: Account;
  readonly grantedCapabilities: ReadonlyArray<string>;
  readonly updatedAt: string;
}
interface PendingFlow {
  readonly deviceCode: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly expiresAt: number;
  readonly intervalSeconds: number;
  readonly generation: number;
}
interface Access {
  readonly token: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly account: Account;
}
interface TokenGrant {
  readonly accessToken: string;
  readonly oauthScopes: ReadonlyArray<string>;
}
type Fetch = typeof globalThis.fetch;

function asRecord(
  value: unknown,
  message = "GitHub returned an invalid response.",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max)
    throw new Error("GitHub returned an invalid response.");
  return value;
}
function boundedInt(value: unknown, minimum: number, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error("GitHub returned an invalid response.");
  return value as number;
}
function exactKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => keys.has(key));
}
function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function validateCapabilities(value: unknown): ReadonlyArray<string> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length !== new Set(value).size ||
    value.some((item) => typeof item !== "string" || !CAPABILITY_NAMES.has(item))
  ) {
    throw new Error("Stored GitHub credential is invalid.");
  }
  return [...value].toSorted() as ReadonlyArray<string>;
}
function validateOauthScopes(value: unknown): ReadonlyArray<string> {
  if (
    !Array.isArray(value) ||
    value.length !== REQUIRED_OAUTH_SCOPES.length ||
    value.length !== new Set(value).size ||
    value.some((item) => typeof item !== "string")
  )
    throw new Error("Stored GitHub credential is invalid.");
  const scopes = [...value].toSorted() as ReadonlyArray<string>;
  if (scopes.join("\n") !== [...REQUIRED_OAUTH_SCOPES].toSorted().join("\n"))
    throw new Error("Stored GitHub credential is invalid.");
  return scopes;
}
function parseCredential(bytes: Uint8Array): Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("Stored GitHub credential is invalid.");
  }
  const value = asRecord(parsed, "Stored GitHub credential is invalid.");
  const allowed = new Set([
    "version",
    "accessToken",
    "oauthScopes",
    "account",
    "grantedCapabilities",
    "updatedAt",
  ]);
  const account = asRecord(value.account, "Stored GitHub credential is invalid.");
  if (
    !exactKeys(value, allowed) ||
    !exactKeys(account, new Set(["login", "id"])) ||
    value.version !== 2 ||
    !validIso(value.updatedAt)
  )
    throw new Error("Stored GitHub credential is invalid.");
  const accessToken = boundedString(value.accessToken, MAX_TOKEN_CHARS);
  const login = boundedString(account.login, 100);
  const id = boundedInt(account.id, 1, Number.MAX_SAFE_INTEGER);
  return {
    version: 2,
    accessToken,
    oauthScopes: validateOauthScopes(value.oauthScopes),
    account: { login, id },
    grantedCapabilities: validateCapabilities(value.grantedCapabilities),
    updatedAt: value.updatedAt,
  };
}
function parseTokenGrant(json: Record<string, unknown>): TokenGrant {
  if (boundedString(json.token_type, 32).toLowerCase() !== "bearer")
    throw new Error("GitHub returned an unexpected token grant.");
  if (
    json.expires_in !== undefined ||
    json.refresh_token !== undefined ||
    json.refresh_token_expires_in !== undefined
  )
    throw new Error("GitHub returned an unexpected expiring token grant.");
  const accessToken = boundedString(json.access_token, MAX_TOKEN_CHARS);
  const scopeValue = boundedString(json.scope, 512);
  const scopes = scopeValue
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)
    .toSorted();
  if (
    scopes.length !== REQUIRED_OAUTH_SCOPES.length ||
    scopes.length !== new Set(scopes).size ||
    scopes.join("\n") !== [...REQUIRED_OAUTH_SCOPES].toSorted().join("\n")
  )
    throw new Error("GitHub did not grant the required OAuth scopes.");
  return { accessToken, oauthScopes: scopes };
}
async function readJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json") && !contentType.includes("+json"))
    throw new Error("GitHub returned an invalid content type.");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumBytes)
    throw new Error("GitHub response exceeded the allowed size.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned an empty response.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("GitHub response exceeded the allowed size.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("GitHub returned invalid JSON.");
  }
}
function accountFrom(value: unknown): Account {
  const user = asRecord(value);
  return {
    login: boundedString(user.login, 100),
    id: boundedInt(user.id, 1, Number.MAX_SAFE_INTEGER),
  };
}
function listResult(value: unknown, limit: number): ReadonlyArray<unknown> {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error("GitHub returned an invalid collection response.");
  return value;
}
function collectionField(value: unknown, field: string, limit: number): Record<string, unknown> {
  const record = asRecord(value);
  if (!Array.isArray(record[field]) || (record[field] as unknown[]).length > limit)
    throw new Error("GitHub returned an invalid collection response.");
  return record;
}
function page(values: { readonly limit?: number; readonly page?: number }) {
  return { limit: values.limit ?? 20, page: values.page ?? 1 };
}
function params(values: Record<string, string | number | undefined>) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") result.set(key, String(value));
  return result.toString();
}

export class GitHubProvider implements IntegrationProvider {
  readonly id = GITHUB_PROVIDER_ID;
  readonly tools = GITHUB_TOOLS;
  readonly #secrets: IntegrationSecretStore;
  readonly #clientId: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingFlow>();
  readonly #polling = new Set<string>();
  readonly #controllers = new Set<AbortController>();
  #access: Access | null = null;
  #generation = 0;
  #credentialRevision = 0;
  #verifiedCredential: {
    readonly revision: number;
    readonly token: string;
    readonly account: Account;
  } | null = null;
  #closed = false;
  #disconnecting = false;
  #uncertainCredentialState = false;
  #credentialMutation: Promise<void> = Promise.resolve();

  constructor(
    secrets: IntegrationSecretStore,
    configuration: GitHubConfiguration,
    fetchImplementation: Fetch = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.#secrets = secrets;
    const clientId = configuration.clientId.trim();
    if (!/^(?!Iv)[A-Za-z0-9]{20,128}$/u.test(clientId))
      throw new Error("GitHub requires a valid public GitHub OAuth App client ID.");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000)
      throw new Error("GitHub requires a bounded request timeout.");
    this.#clientId = clientId;
    this.#fetch = fetchImplementation;
    this.#timeoutMs = requestTimeoutMs;
  }

  async #request(
    url: string,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<{ response: Response; json: unknown }> {
    if (this.#closed) throw new Error("GitHub provider is closed.");
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signals = [controller.signal, timeout];
    if (init.signal) signals.push(init.signal);
    try {
      const response = await this.#fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
      return { response, json: await readJson(response, maximumBytes) };
    } catch (error) {
      if (init.signal?.aborted) throw new Error("GitHub request was cancelled.", { cause: error });
      if (controller.signal.aborted)
        throw new Error("GitHub provider was closed.", { cause: error });
      if (timeout.aborted) throw new Error("GitHub request timed out.", { cause: error });
      throw error;
    } finally {
      this.#controllers.delete(controller);
    }
  }
  #postAuth(url: string, form: Readonly<Record<string, string>>, signal?: AbortSignal) {
    return this.#request(
      url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form),
        signal: signal ?? null,
      },
      AUTH_RESPONSE_BYTES,
    );
  }
  #serialize<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#credentialMutation.then(operation, operation);
    this.#credentialMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  async #readCredential(signal?: AbortSignal): Promise<Credential | null> {
    const stored = await Effect.runPromise(this.#secrets.get(GITHUB_SECRET_SUFFIX), { signal });
    return Option.isSome(stored) ? parseCredential(stored.value) : null;
  }
  async #writeCredential(value: Credential, signal: AbortSignal) {
    await Effect.runPromise(
      this.#secrets.set(GITHUB_SECRET_SUFFIX, encoder.encode(JSON.stringify(value))),
      { signal },
    );
    await Effect.runPromise(this.#secrets.remove(LEGACY_GITHUB_APP_SECRET_SUFFIX), { signal });
  }
  async #beginCommit(context?: IntegrationLifecycleContext): Promise<AbortSignal> {
    if (!context || typeof context.beginCommit !== "function")
      throw new Error("GitHub credential mutation requires Harness commit admission.");
    return context.beginCommit();
  }
  async #api(
    path: string,
    token: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "PUT";
      body?: unknown;
      signal?: AbortSignal;
      maximumBytes?: number;
    } = {},
  ): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("://"))
      throw new Error("GitHub endpoint is invalid.");
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": API_VERSION,
      "user-agent": "TritonAI-GitHub-Plugin/1.0",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const { response, json } = await this.#request(
      `${GITHUB_API_ORIGIN}${path}`,
      {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: options.signal ?? null,
      },
      options.maximumBytes ?? API_RESPONSE_BYTES,
    );
    if (!response.ok) {
      if (response.status === 401) {
        if (this.#access?.token === token) this.#access = null;
        if (this.#verifiedCredential?.token === token) this.#verifiedCredential = null;
        throw new IntegrationProviderPublicError(
          "The GitHub session expired or was revoked. Reconnect GitHub.",
        );
      }
      if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
        throw new IntegrationProviderPublicError(
          "GitHub is rate limiting this account. Try again after the rate-limit reset.",
        );
      if (response.status === 403)
        throw new IntegrationProviderPublicError(
          "GitHub denied this request. Check the signed-in user's repository permission, organization policy, and OAuth authorization.",
        );
      if (response.status === 404)
        throw new IntegrationProviderPublicError(
          "GitHub could not find that item, or the signed-in user cannot access it.",
        );
      if (response.status === 409)
        throw new IntegrationProviderPublicError(
          "GitHub could not complete the request because the repository state conflicts with it.",
        );
      if (response.status === 422)
        throw new IntegrationProviderPublicError(
          "GitHub rejected the requested change. Check names, refs, and current repository state.",
        );
      if (response.status === 429)
        throw new IntegrationProviderPublicError(
          "GitHub is temporarily rate limiting requests. Try again later.",
        );
      if (response.status >= 400 && response.status < 500)
        throw new IntegrationProviderPublicError("GitHub could not accept this request.");
      throw new Error(`GitHub API request failed with HTTP ${response.status}.`);
    }
    return json;
  }
  async #verify(token: string, signal?: AbortSignal): Promise<Account> {
    return accountFrom(await this.#api("/user", token, { signal }));
  }

  async status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus> {
    if (this.#closed)
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "The GitHub provider is closed.",
      };
    if (this.#disconnecting)
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "GitHub is disconnecting.",
      };
    if (this.#uncertainCredentialState)
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "GitHub credential state is uncertain. Disconnect to reset it.",
      };
    if (context?.signal.aborted)
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "The GitHub status check was cancelled.",
      };
    const generation = this.#generation;
    const revision = this.#credentialRevision;
    try {
      const credential = await this.#readCredential(context?.signal);
      if (
        generation !== this.#generation ||
        revision !== this.#credentialRevision ||
        this.#disconnecting
      )
        return {
          state: "error",
          accountLabel: null,
          grantedCapabilities: [],
          message: "GitHub connection state changed while status was checked.",
        };
      const now = Date.now();
      for (const [id, flow] of this.#pending)
        if (flow.expiresAt <= now && !this.#polling.has(id)) this.#pending.delete(id);
      if (!credential)
        return {
          state: this.#pending.size > 0 ? "connecting" : "not_connected",
          accountLabel: null,
          grantedCapabilities: [],
          message: null,
        };
      return {
        state: "connected",
        accountLabel: credential.account.login,
        grantedCapabilities: credential.grantedCapabilities,
        message:
          "Connected through GitHub OAuth. Access follows the signed-in user's GitHub permissions.",
      };
    } catch {
      if (context?.signal.aborted)
        return {
          state: "error",
          accountLabel: null,
          grantedCapabilities: [],
          message: "The GitHub status check was cancelled.",
        };
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "The stored GitHub connection could not be verified. Disconnect to reset it.",
      };
    }
  }

  async connect(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationDeviceCodeConnectResult> {
    if (submission !== undefined) throw new Error("GitHub device sign-in rejects submissions.");
    if (this.#closed || this.#disconnecting || this.#uncertainCredentialState)
      throw new Error("GitHub is unavailable.");
    if (context?.signal.aborted) throw new Error("GitHub sign-in was cancelled.");
    if (
      capabilities.length === 0 ||
      capabilities.length !== new Set(capabilities).size ||
      capabilities.some((capability) => !CAPABILITY_NAMES.has(capability))
    )
      throw new Error("Unsupported GitHub capability.");
    const generation = this.#generation;
    const requested = [...new Set(capabilities)].toSorted();
    const { response, json: raw } = await this.#postAuth(
      DEVICE_CODE_URL,
      { client_id: this.#clientId, scope: REQUIRED_OAUTH_SCOPE },
      context?.signal,
    );
    if (!response.ok)
      throw new IntegrationProviderPublicError(
        "GitHub sign-in could not start. Confirm device flow is enabled for the GitHub OAuth App.",
      );
    const json = asRecord(raw);
    const deviceCode = boundedString(json.device_code, MAX_TOKEN_CHARS);
    const userCode = boundedString(json.user_code, 64);
    const verificationUri = boundedString(json.verification_uri, 2_048);
    if (verificationUri !== `${GITHUB_WEB_ORIGIN}/login/device`)
      throw new Error("GitHub returned an invalid verification address.");
    const expiresIn = boundedInt(json.expires_in, 60, 1_800);
    const interval = boundedInt(json.interval, 1, 60, 5);
    if (generation !== this.#generation || this.#closed || this.#disconnecting)
      throw new Error("GitHub sign-in was superseded while starting.");
    this.#pending.clear();
    const flowId = crypto.randomUUID();
    const expiresAt = Date.now() + expiresIn * 1_000;
    this.#pending.set(flowId, {
      deviceCode,
      capabilities: requested,
      expiresAt,
      intervalSeconds: interval,
      generation,
    });
    return {
      kind: "device_code",
      flowId,
      verificationUri,
      verificationUriComplete: null,
      userCode,
      message: `Open ${verificationUri} and enter ${userCode}.`,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: interval,
    };
  }

  async poll(
    flowId: string,
    context?: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResult> {
    const flow = this.#pending.get(flowId);
    if (!flow)
      throw new IntegrationProviderPublicError(
        "GitHub sign-in flow was not found. Start sign-in again.",
      );
    if (this.#polling.has(flowId))
      throw new IntegrationProviderPublicError("GitHub sign-in is already being checked.");
    if (flow.expiresAt <= Date.now()) {
      this.#pending.delete(flowId);
      return {
        state: "expired",
        retryAfterSeconds: null,
        message: "GitHub sign-in expired. Start again.",
      };
    }
    this.#polling.add(flowId);
    let admitted = false;
    let tokenIssued = false;
    try {
      const signal = await this.#beginCommit(context);
      admitted = true;
      const { response, json: raw } = await this.#postAuth(
        TOKEN_URL,
        {
          client_id: this.#clientId,
          device_code: flow.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        signal,
      );
      const json = asRecord(raw);
      if (flow.generation !== this.#generation || !this.#pending.has(flowId) || this.#disconnecting)
        throw new Error("GitHub sign-in was superseded.");
      if (!response.ok || typeof json.error === "string") {
        const error = typeof json.error === "string" ? json.error : "unknown";
        if (error === "authorization_pending")
          return {
            state: "pending",
            retryAfterSeconds: flow.intervalSeconds,
            message: "Waiting for GitHub sign-in.",
          };
        if (error === "slow_down") {
          const next = Math.min(60, flow.intervalSeconds + 5);
          this.#pending.set(flowId, { ...flow, intervalSeconds: next });
          return {
            state: "pending",
            retryAfterSeconds: next,
            message: "GitHub asked TritonAI to check less often.",
          };
        }
        this.#pending.delete(flowId);
        if (error === "expired_token")
          return {
            state: "expired",
            retryAfterSeconds: null,
            message: "GitHub sign-in expired. Start again.",
          };
        if (error === "access_denied")
          return {
            state: "failed",
            retryAfterSeconds: null,
            message: "GitHub sign-in was cancelled. Start again when ready.",
          };
        if (error === "device_flow_disabled")
          return {
            state: "failed",
            retryAfterSeconds: null,
            message: "Device flow is not enabled for the TritonAI GitHub OAuth App.",
          };
        return {
          state: "failed",
          retryAfterSeconds: null,
          message: "GitHub sign-in failed. Start again.",
        };
      }
      const grant = parseTokenGrant(json);
      tokenIssued = true;
      const account = await this.#verify(grant.accessToken, signal);
      const credential: Credential = {
        version: 2,
        accessToken: grant.accessToken,
        oauthScopes: grant.oauthScopes,
        account,
        grantedCapabilities: flow.capabilities,
        updatedAt: new Date().toISOString(),
      };
      await this.#serialize(async () => {
        if (
          flow.generation !== this.#generation ||
          !this.#pending.has(flowId) ||
          this.#disconnecting
        )
          throw new Error("GitHub sign-in was superseded before credential commit.");
        await this.#writeCredential(credential, signal);
        this.#credentialRevision += 1;
        this.#verifiedCredential = {
          revision: this.#credentialRevision,
          token: grant.accessToken,
          account,
        };
        this.#generation += 1;
        this.#pending.clear();
        this.#access = {
          token: grant.accessToken,
          capabilities: flow.capabilities,
          account,
        };
      });
      return {
        state: "connected",
        retryAfterSeconds: null,
        message: `GitHub is connected as ${account.login}. Repository access follows this account's GitHub permissions.`,
      };
    } catch (error) {
      if (admitted && tokenIssued) this.#uncertainCredentialState = true;
      throw error;
    } finally {
      this.#polling.delete(flowId);
    }
  }

  prepare(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serialize(async () => {
      if (this.#closed || this.#disconnecting || this.#uncertainCredentialState)
        throw new Error("GitHub is unavailable.");
      const credential = await this.#readCredential(context?.signal);
      if (!credential) {
        this.#access = null;
        this.#verifiedCredential = null;
        return;
      }
      const cached = this.#verifiedCredential;
      const account =
        cached?.revision === this.#credentialRevision && cached.token === credential.accessToken
          ? cached.account
          : await this.#verify(credential.accessToken, context?.signal);
      if (account.id !== credential.account.id)
        throw new Error("GitHub token identity changed unexpectedly.");
      this.#verifiedCredential = {
        revision: this.#credentialRevision,
        token: credential.accessToken,
        account,
      };
      this.#access = {
        token: credential.accessToken,
        capabilities: credential.grantedCapabilities,
        account,
      };
    });
  }

  disconnect(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serialize(async () => {
      this.#disconnecting = true;
      this.#generation += 1;
      this.#pending.clear();
      this.#access = null;
      this.#verifiedCredential = null;
      let admitted = false;
      try {
        const signal = await this.#beginCommit(context);
        admitted = true;
        await Effect.runPromise(this.#secrets.remove(GITHUB_SECRET_SUFFIX), { signal });
        await Effect.runPromise(this.#secrets.remove(LEGACY_GITHUB_APP_SECRET_SUFFIX), { signal });
        this.#credentialRevision += 1;
        this.#uncertainCredentialState = false;
      } catch (error) {
        if (admitted) this.#uncertainCredentialState = true;
        throw error;
      } finally {
        this.#disconnecting = false;
      }
    });
  }

  #require(capability: string): Access {
    const access = this.#access;
    if (!access)
      throw new IntegrationProviderPublicError(
        "GitHub access needs preparation or reconnection before use.",
      );
    if (!access.capabilities.includes(capability))
      throw new IntegrationProviderPublicError(`GitHub ${capability} access is not enabled.`);
    return access;
  }
  async #writeSignal(context?: IntegrationInvocationContext): Promise<AbortSignal> {
    if (context?.writeApproved !== true || typeof context.beginCommit !== "function")
      throw new Error("GitHub writes require Harness approval and commit admission.");
    return context.beginCommit();
  }
  #assertCurrent(generation: number) {
    if (
      this.#closed ||
      this.#disconnecting ||
      this.#uncertainCredentialState ||
      generation !== this.#generation
    )
      throw new Error("GitHub access was revoked or became uncertain.");
  }
  async #decode<A>(schema: Schema.Decoder<A>, input: unknown): Promise<A> {
    return Schema.decodeUnknownPromise(schema)(input, { errors: "all", onExcessProperty: "error" });
  }

  async invoke(
    toolName: string,
    input: unknown,
    context?: IntegrationInvocationContext,
  ): Promise<unknown> {
    if (this.#closed || this.#disconnecting || this.#uncertainCredentialState)
      throw new Error("GitHub is unavailable.");
    if (context?.signal.aborted) throw new Error("GitHub request was cancelled.");
    const isIssueWrite =
      toolName.startsWith("github.issues.") &&
      ["github.issues.create", "github.issues.update", "github.issues.comment.create"].includes(
        toolName,
      );
    const isPullWrite = [
      "github.pulls.create",
      "github.pulls.comment.create",
      "github.pulls.review.create",
    ].includes(toolName);
    const isRepositoryWrite = [
      "github.repositories.fork",
      "github.branches.create",
      "github.contents.put",
    ].includes(toolName);
    const capability = isIssueWrite
      ? "issues.write"
      : isPullWrite
        ? "pull-requests.write"
        : isRepositoryWrite
          ? "repository.write"
          : toolName === "github.identity.get"
            ? "identity.read"
            : "repository.read";
    const access = this.#require(capability);
    const generation = this.#generation;
    const read = async (path: string, maximumBytes?: number) => {
      const result = await this.#api(path, access.token, { signal: context?.signal, maximumBytes });
      this.#assertCurrent(generation);
      return result;
    };
    const write = async (path: string, method: "POST" | "PATCH" | "PUT", body: unknown) => {
      const signal = await this.#writeSignal(context);
      this.#assertCurrent(generation);
      const result = await this.#api(path, access.token, { method, body, signal });
      this.#assertCurrent(generation);
      return asRecord(result);
    };

    if (toolName === "github.identity.get") {
      await this.#decode(EmptyInput, input);
      const result = await read("/user");
      accountFrom(result);
      return result;
    }
    if (toolName === "github.repositories.list") {
      const values = await this.#decode(RepositoriesListInput, input);
      const p = page(values);
      return listResult(
        await read(
          `/user/repos?${params({ visibility: "all", affiliation: "owner,collaborator,organization_member", sort: "updated", direction: "desc", per_page: p.limit, page: p.page })}`,
        ),
        p.limit,
      );
    }
    if (toolName === "github.repositories.get") {
      const values = await this.#decode(RepositoryGetInput, input);
      return asRecord(
        await read(`/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}`),
      );
    }
    if (toolName === "github.repositories.fork") {
      const values = await this.#decode(RepositoryForkInput, input);
      return write(
        `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/forks`,
        "POST",
        {},
      );
    }
    if (toolName === "github.branches.create") {
      const values = await this.#decode(BranchCreateInput, input);
      const prefix = `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}`;
      const source = asRecord(
        await read(`${prefix}/commits/${encodeURIComponent(values.fromRef)}`),
      );
      const sha = boundedString(source.sha, 64);
      if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("GitHub returned an invalid commit SHA.");
      return write(`${prefix}/git/refs`, "POST", { ref: `refs/heads/${values.branch}`, sha });
    }
    if (toolName === "github.repositories.search") {
      const values = await this.#decode(RepositorySearchInput, input);
      const p = page(values);
      return collectionField(
        await read(
          `/search/repositories?${params({ q: values.query.trim(), per_page: p.limit, page: p.page })}`,
        ),
        "items",
        p.limit,
      );
    }
    if (toolName === "github.contents.get") {
      const values = await this.#decode(ContentsGetInput, input);
      const suffix = values.ref === undefined ? "" : `?${params({ ref: values.ref })}`;
      const result = await read(
        `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/contents/${values.path.split("/").map(encodeURIComponent).join("/")}${suffix}`,
        CONTENT_RESPONSE_BYTES,
      );
      if (Array.isArray(result))
        throw new IntegrationProviderPublicError(
          "That path is a directory. Provide an exact file path.",
        );
      const file = asRecord(result);
      if (
        file.type !== "file" ||
        boundedInt(file.size, 0, Number.MAX_SAFE_INTEGER) > MAX_FILE_BYTES ||
        typeof file.content !== "string" ||
        file.content.length > 1_500_000
      )
        throw new IntegrationProviderPublicError(
          "GitHub file content is unavailable or exceeds the one-megabyte limit.",
        );
      return file;
    }
    if (toolName === "github.contents.put") {
      const values = await this.#decode(ContentsPutInput, input);
      const bytes = encoder.encode(values.content);
      if (bytes.byteLength > MAX_FILE_BYTES)
        throw new IntegrationProviderPublicError(
          "GitHub file content exceeds the one-megabyte UTF-8 limit.",
        );
      return write(
        `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/contents/${values.path.split("/").map(encodeURIComponent).join("/")}`,
        "PUT",
        {
          message: values.message,
          content: Buffer.from(bytes).toString("base64"),
          branch: values.branch,
          ...(values.sha === undefined ? {} : { sha: values.sha }),
        },
      );
    }
    if (toolName === "github.code.search") {
      const values = await this.#decode(CodeSearchInput, input);
      const p = page(values);
      const q = `${values.query.trim()} repo:${values.owner}/${values.repo}`;
      return collectionField(
        await read(`/search/code?${params({ q, per_page: p.limit, page: p.page })}`),
        "items",
        p.limit,
      );
    }
    if (toolName === "github.issues.list") {
      const values = await this.#decode(IssuesListInput, input);
      const p = page(values);
      const labels = values.labels?.join(",");
      return listResult(
        await read(
          `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/issues?${params({ state: values.state ?? "open", labels, per_page: p.limit, page: p.page })}`,
        ),
        p.limit,
      );
    }
    if (toolName === "github.issues.search") {
      const values = await this.#decode(IssuesSearchInput, input);
      const p = page(values);
      const q = `${values.query.trim()} repo:${values.owner}/${values.repo}`;
      return collectionField(
        await read(`/search/issues?${params({ q, per_page: p.limit, page: p.page })}`),
        "items",
        p.limit,
      );
    }
    if (toolName === "github.issues.get") {
      const values = await this.#decode(NumberInput, input);
      return asRecord(
        await read(
          `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/issues/${values.number}`,
        ),
      );
    }
    if (
      toolName === "github.issues.comments.list" ||
      toolName === "github.pulls.review-comments.list" ||
      toolName === "github.pulls.reviews.list"
    ) {
      const values = await this.#decode(NumberPageInput, input);
      const p = page(values);
      const tail =
        toolName === "github.issues.comments.list"
          ? `issues/${values.number}/comments`
          : toolName === "github.pulls.reviews.list"
            ? `pulls/${values.number}/reviews`
            : `pulls/${values.number}/comments`;
      return listResult(
        await read(
          `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/${tail}?${params({ per_page: p.limit, page: p.page })}`,
        ),
        p.limit,
      );
    }
    if (toolName === "github.issues.create") {
      const values = await this.#decode(IssueCreateInput, input);
      return write(
        `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/issues`,
        "POST",
        {
          title: values.title,
          ...(values.body === undefined ? {} : { body: values.body }),
          ...(values.labels === undefined ? {} : { labels: values.labels }),
          ...(values.assignees === undefined ? {} : { assignees: values.assignees }),
        },
      );
    }
    if (toolName === "github.issues.update") {
      const values = await this.#decode(IssueUpdateInput, input);
      const body = {
        ...(values.title === undefined ? {} : { title: values.title }),
        ...(values.body === undefined ? {} : { body: values.body }),
        ...(values.state === undefined ? {} : { state: values.state }),
        ...(values.labels === undefined ? {} : { labels: values.labels }),
        ...(values.assignees === undefined ? {} : { assignees: values.assignees }),
      };
      if (Object.keys(body).length === 0)
        throw new IntegrationProviderPublicError(
          "Issue update must include at least one changed field.",
        );
      const issuePath = `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/issues/${values.number}`;
      const target = asRecord(await read(issuePath));
      if (Object.hasOwn(target, "pull_request"))
        throw new IntegrationProviderPublicError(
          "That number belongs to a pull request. Use a pull-request tool.",
        );
      return write(issuePath, "PATCH", body);
    }
    if (toolName === "github.issues.comment.create" || toolName === "github.pulls.comment.create") {
      const values = await this.#decode(CommentCreateInput, input);
      const issuePath = `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/issues/${values.number}`;
      const target = asRecord(await read(issuePath));
      const targetsPullRequest = Object.hasOwn(target, "pull_request");
      if (toolName === "github.issues.comment.create" && targetsPullRequest)
        throw new IntegrationProviderPublicError(
          "That number belongs to a pull request. Use the pull-request comment tool.",
        );
      if (toolName === "github.pulls.comment.create" && !targetsPullRequest)
        throw new IntegrationProviderPublicError(
          "That number belongs to an issue. Use the issue comment tool.",
        );
      return write(`${issuePath}/comments`, "POST", { body: values.body });
    }
    if (toolName === "github.pulls.list") {
      const values = await this.#decode(PullsListInput, input);
      const p = page(values);
      return listResult(
        await read(
          `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/pulls?${params({ state: values.state ?? "open", base: values.base, head: values.head, per_page: p.limit, page: p.page })}`,
        ),
        p.limit,
      );
    }
    if (toolName === "github.pulls.get") {
      const values = await this.#decode(NumberInput, input);
      return asRecord(
        await read(
          `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/pulls/${values.number}`,
        ),
      );
    }
    if (toolName === "github.pulls.create") {
      const values = await this.#decode(PullCreateInput, input);
      if (values.head === values.base)
        throw new IntegrationProviderPublicError("Pull-request head and base refs must differ.");
      return write(
        `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/pulls`,
        "POST",
        {
          title: values.title,
          head: values.head,
          base: values.base,
          ...(values.body === undefined ? {} : { body: values.body }),
          draft: values.draft ?? false,
        },
      );
    }
    if (toolName === "github.pulls.review.create") {
      const values = await this.#decode(ReviewCreateInput, input);
      return write(
        `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/pulls/${values.number}/reviews`,
        "POST",
        { event: values.event, body: values.body },
      );
    }
    if (toolName === "github.actions.runs.list") {
      const values = await this.#decode(ActionsRunsListInput, input);
      const p = page(values);
      return collectionField(
        await read(
          `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/actions/runs?${params({ branch: values.branch, status: values.status, per_page: p.limit, page: p.page })}`,
        ),
        "workflow_runs",
        p.limit,
      );
    }
    if (toolName === "github.actions.run.get") {
      const values = await this.#decode(RunInput, input);
      return asRecord(
        await read(
          `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/actions/runs/${values.runId}`,
        ),
      );
    }
    if (toolName === "github.actions.jobs.list") {
      const values = await this.#decode(JobsInput, input);
      const p = page(values);
      return collectionField(
        await read(
          `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/actions/runs/${values.runId}/jobs?${params({ per_page: p.limit, page: p.page })}`,
        ),
        "jobs",
        p.limit,
      );
    }
    if (toolName === "github.commits.check-runs.list") {
      const values = await this.#decode(CommitInput, input);
      const p = page(values);
      return collectionField(
        await read(
          `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/commits/${encodeURIComponent(values.ref)}/check-runs?${params({ per_page: p.limit, page: p.page })}`,
        ),
        "check_runs",
        p.limit,
      );
    }
    if (toolName === "github.commits.status.get") {
      const values = await this.#decode(CommitStatusInput, input);
      return asRecord(
        await read(
          `/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repo)}/commits/${encodeURIComponent(values.ref)}/status`,
        ),
      );
    }
    throw new Error("Unsupported GitHub tool.");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#pending.clear();
    this.#access = null;
    this.#verifiedCredential = null;
    for (const controller of this.#controllers) controller.abort();
    await this.#credentialMutation;
  }
}
