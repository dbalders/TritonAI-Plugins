// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off cryptoRandomUUID:off
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeUtil from "node:util";

import {
  type IntegrationAuthorizationUrlConnectResult,
  type IntegrationConnectionSubmission,
  type IntegrationInvocationContext,
  type IntegrationLifecycleContext,
  type IntegrationProvider,
  ExternalCommitOutcomeUnknownError,
  IntegrationProviderPublicError,
  type IntegrationProviderPollResult,
  type IntegrationProviderStatus,
  type IntegrationProviderTool,
  type IntegrationSecretStore,
  type JsonObject,
  type JsonValue,
} from "./host-contract.js";
import { EmptyInput, decoderFromJsonSchema, mergeAllOfMembers } from "./upstream-schema.js";
import { UPSTREAM_TOOLS } from "./upstream-tools.js";

export const N8N_PROVIDER_ID = "n8n";
export const N8N_SECRET_SUFFIX = "oauth";
/** A disconnected grant n8n has not yet confirmed revoking, retried on the next connect or disconnect. */
export const N8N_REVOCATION_SECRET_SUFFIX = "oauth-revocation";

const REVIEWED_SERVER_URL = "https://n8n.tritonai.ucsd.edu/mcp-server/http";
const CALLBACK_PATH = "/oauth2/callback";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const MCP_CLIENT_INFO = { name: "TritonAI Harness", version: "1.0.0" } as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const REVOCATION_RETRY_BUDGET_MS = 5_000;
const TEST_REQUEST_TIMEOUT_MS = 5 * 60_000 + 10_000;
const FLOW_LIFETIME_MS = 5 * 60_000;
const FLOW_CALLBACK_CLAIM_MS = 60_000;
const FLOW_POLL_SECONDS = 2;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const METADATA_RESPONSE_BYTES = 128 * 1024;
const TOKEN_RESPONSE_BYTES = 128 * 1024;
const MCP_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MCP_TOOL_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOKEN_CHARS = 16_384;
const MAX_CLIENT_ID_CHARS = 1_024;
const MAX_SESSION_ID_CHARS = 1_024;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 100_000;
const MAX_MCP_PAGES = 8;
const MAX_MCP_TOOLS = 256;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

// Every MCP scope n8n 2.41.3 can grant. n8n grows this list as it adds MCP features, so discovery
// treats the advertised list as a menu: reviewed scopes it offers are requested, reviewed scopes
// it omits (for example, agent scopes while the agents module is off) are skipped, and scopes
// this plugin has not reviewed yet are ignored until a plugin update exposes their tools.
const READ_OAUTH_SCOPES = [
  "agent:read",
  "aiPreference:read",
  "credential:read",
  "dataTable:read",
  "execution:read",
  "project:read",
  "tag:read",
  "workflow:read",
] as const;
const WRITE_OAUTH_SCOPES = [
  "agent:execute",
  "agent:write",
  "communityPackage:install",
  "dataTable:write",
  "project:write",
  "workflow:execute",
  "workflow:write",
] as const;
const OAUTH_SCOPES = [...READ_OAUTH_SCOPES, ...WRITE_OAUTH_SCOPES] as const;
const OAUTH_SCOPE_SET = new Set<string>(OAUTH_SCOPES);
const READ_OAUTH_SCOPE_SET = new Set<string>(READ_OAUTH_SCOPES);
const WRITE_OAUTH_SCOPE_SET = new Set<string>(WRITE_OAUTH_SCOPES);
const MAX_ADVERTISED_SCOPES = 256;

const CAPABILITIES = ["read", "write"] as const;
const CAPABILITY_SET = new Set<string>(CAPABILITIES);

export interface N8nConfiguration {
  readonly serverUrl: string;
}

const BoundedId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^[^\p{Cc}\s]+$/u),
);
const BoundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Code = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300_000));
const OptionalQuery = Schema.optionalKey(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
);
const OptionalProjectId = Schema.optionalKey(BoundedId);
const OptionalFolderId = Schema.optionalKey(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(36),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
  ),
);
const OptionalLimit100 = Schema.optionalKey(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
);
const OptionalLimit200 = Schema.optionalKey(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
);
const JsonObject = Schema.Record(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  Schema.Unknown,
);

const SearchWorkflowsInput = Schema.Struct({
  query: OptionalQuery,
  projectId: OptionalProjectId,
  tags: Schema.optionalKey(
    Schema.Array(BoundedText).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  ),
  limit: OptionalLimit200,
  sortBy: Schema.optionalKey(
    Schema.Literals([
      "updatedAt:desc",
      "updatedAt:asc",
      "createdAt:desc",
      "createdAt:asc",
      "name:asc",
      "name:desc",
    ]),
  ),
  folderId: OptionalFolderId,
  includeSubfolders: Schema.optionalKey(Schema.Boolean),
});
const WorkflowIdInput = Schema.Struct({ workflowId: BoundedId });
const WorkflowDetailsInput = Schema.Struct({
  workflowId: BoundedId,
  detailLevel: Schema.optionalKey(Schema.Literals(["full", "execution"])),
});
const WorkflowHistoryInput = Schema.Struct({
  workflowId: BoundedId,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
});
const WorkflowVersionInput = Schema.Struct({ workflowId: BoundedId, versionId: BoundedId });
const ExecuteWorkflowInput = Schema.Struct({
  workflowId: BoundedId,
  executionMode: Schema.Literals(["manual", "production"]),
  triggerNodeName: Schema.optionalKey(BoundedText),
  inputs: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ chatInput: BoundedText }),
      Schema.Struct({ formData: JsonObject }),
      Schema.Struct({
        webhookData: Schema.Struct({
          method: Schema.optionalKey(
            Schema.Literals(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]),
          ),
          query: Schema.optionalKey(Schema.Record(BoundedText, Schema.String)),
          body: Schema.optionalKey(JsonObject),
          headers: Schema.optionalKey(Schema.Record(BoundedText, Schema.String)),
        }),
      }),
    ]),
  ),
});
const TestWorkflowInput = Schema.Struct({
  workflowId: BoundedId,
  pinData: Schema.Record(BoundedText, Schema.Array(JsonObject).check(Schema.isMaxLength(1_000))),
  triggerNodeName: Schema.optionalKey(BoundedText),
  timeout: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600 }))),
});
const PublishWorkflowInput = Schema.Struct({
  workflowId: BoundedId,
  versionId: Schema.optionalKey(BoundedId),
});
const SearchProjectsInput = Schema.Struct({
  query: OptionalQuery,
  type: Schema.optionalKey(Schema.Literals(["personal", "team"])),
  limit: OptionalLimit100,
});
const SearchFoldersInput = Schema.Struct({
  projectId: BoundedId,
  query: OptionalQuery,
  limit: OptionalLimit100,
});
const ListTagsInput = Schema.Struct({
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
const GetExecutionInput = Schema.Struct({
  workflowId: BoundedId,
  executionId: BoundedId,
  includeData: Schema.optionalKey(Schema.Boolean),
  nodeNames: Schema.optionalKey(
    Schema.Array(BoundedText).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
  truncateData: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
  ),
});
const SearchExecutionsInput = Schema.Struct({
  workflowId: Schema.optionalKey(BoundedId),
  status: Schema.optionalKey(
    Schema.Array(
      Schema.Literals([
        "canceled",
        "crashed",
        "error",
        "new",
        "running",
        "success",
        "unknown",
        "waiting",
      ]),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  ),
  startedAfter: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(64)),
  ),
  startedBefore: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(64)),
  ),
  limit: OptionalLimit200,
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))),
});
const ListCredentialsInput = Schema.Struct({
  limit: OptionalLimit200,
  query: OptionalQuery,
  type: Schema.optionalKey(BoundedText),
  projectId: OptionalProjectId,
  onlySharedWithMe: Schema.optionalKey(Schema.Boolean),
});
const GetSdkReferenceInput = Schema.Struct({
  section: Schema.optionalKey(
    Schema.Literals([
      "patterns",
      "patterns_detailed",
      "expressions",
      "functions",
      "rules",
      "import",
      "guidelines",
      "design",
      "all",
      "groups",
    ]),
  ),
});
const SearchNodesInput = Schema.Struct({
  queries: Schema.Array(BoundedText).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  usage: Schema.optionalKey(Schema.Literals(["workflow", "agentTool"])),
});
const NodeTypeRequest = Schema.Struct({
  nodeId: BoundedText,
  version: Schema.optionalKey(BoundedText),
  resource: Schema.optionalKey(BoundedText),
  operation: Schema.optionalKey(BoundedText),
  mode: Schema.optionalKey(BoundedText),
});
const GetNodeTypesInput = Schema.Struct({
  nodeIds: Schema.Array(NodeTypeRequest).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});
const BestPracticesInput = Schema.Struct({
  technique: Schema.Union([
    Schema.Literals([
      "scheduling",
      "chatbot",
      "form_input",
      "scraping_and_research",
      "monitoring",
      "enrichment",
      "triage",
      "content_generation",
      "document_processing",
      "data_extraction",
      "data_analysis",
      "data_transformation",
      "data_persistence",
      "notification",
      "knowledge_base",
      "human_in_the_loop",
      "web_app",
    ]),
    Schema.Literal("list"),
  ]),
});
const ExploreNodeResourcesInput = Schema.Struct({
  nodeType: BoundedText,
  version: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  methodName: BoundedText,
  methodType: Schema.Literals(["listSearch", "loadOptions"]),
  credentialType: BoundedText,
  credentialId: BoundedId,
  filter: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  paginationToken: Schema.optionalKey(BoundedId),
  currentNodeParameters: Schema.optionalKey(JsonObject),
});
const ValidateWorkflowInput = Schema.Struct({ code: Code });
const NodeConfiguration = Schema.Struct({
  name: Schema.optionalKey(BoundedText),
  type: BoundedText,
  typeVersion: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  ),
  parameters: Schema.optionalKey(JsonObject),
  subnodes: Schema.optionalKey(Schema.Unknown),
  isToolNode: Schema.optionalKey(Schema.Boolean),
});
const ValidateNodeConfigInput = Schema.Struct({
  nodes: Schema.Array(NodeConfiguration).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});
const SkillsUsed = Schema.optionalKey(Schema.Array(BoundedText).check(Schema.isMaxLength(100)));
const CreateWorkflowInput = Schema.Struct({
  code: Code,
  skillsUsed: SkillsUsed,
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
  versionName: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  ),
  versionDescription: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_000))),
  projectId: OptionalProjectId,
  folderId: Schema.optionalKey(BoundedId),
});
const PositionCoordinate = Schema.Finite.check(
  Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }),
);
const NodePosition = Schema.Array(PositionCoordinate).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(2),
);
const NodeCredentials = Schema.Record(
  BoundedText,
  Schema.Struct({ id: Schema.optionalKey(BoundedId), name: BoundedText }),
);
const NewNode = Schema.Struct({
  id: Schema.optionalKey(BoundedId),
  name: BoundedText,
  type: BoundedText,
  typeVersion: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  parameters: Schema.optionalKey(JsonObject),
  position: Schema.optionalKey(NodePosition),
  credentials: Schema.optionalKey(NodeCredentials),
  disabled: Schema.optionalKey(Schema.Boolean),
  notes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
});
const ConnectionFields = {
  source: BoundedText,
  target: BoundedText,
  sourceIndex: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 })),
  ),
  targetIndex: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 })),
  ),
  connectionType: Schema.optionalKey(BoundedText),
} as const;
const UpdateSettings = Schema.Struct({
  onError: Schema.optionalKey(
    Schema.Literals(["stopWorkflow", "continueRegularOutput", "continueErrorOutput"]),
  ),
  retryOnFail: Schema.optionalKey(Schema.Boolean),
  maxTries: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 }))),
  waitBetweenTries: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5_000 })),
  ),
  alwaysOutputData: Schema.optionalKey(Schema.Boolean),
  executeOnce: Schema.optionalKey(Schema.Boolean),
  errorWorkflow: Schema.optionalKey(BoundedId),
  timezone: Schema.optionalKey(BoundedText),
  executionOrder: Schema.optionalKey(Schema.Literals(["v0", "v1"])),
  saveExecutionProgress: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Literal("DEFAULT")]),
  ),
  saveManualExecutions: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Literal("DEFAULT")]),
  ),
  saveDataErrorExecution: Schema.optionalKey(Schema.Literals(["DEFAULT", "all", "none"])),
  saveDataSuccessExecution: Schema.optionalKey(Schema.Literals(["DEFAULT", "all", "none"])),
  executionTimeout: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 31_536_000 })),
  ),
  timeSavedPerExecution: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  ),
  callerPolicy: Schema.optionalKey(
    Schema.Literals(["any", "none", "workflowsFromAList", "workflowsFromSameOwner"]),
  ),
  callerIds: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
});
const UpdateOperation = Schema.Struct({
  type: Schema.Literals([
    "updateNodeParameters",
    "setNodeParameter",
    "addNode",
    "removeNode",
    "renameNode",
    "addConnection",
    "removeConnection",
    "setNodeCredential",
    "setNodePosition",
    "setNodeDisabled",
    "setNodeSettings",
    "setWorkflowMetadata",
    "setWorkflowSettings",
    "addTags",
    "removeTags",
    "setNodeGroups",
    "addNodeGroup",
    "removeNodeGroup",
    "updateNodeGroup",
  ]),
  nodeName: Schema.optionalKey(BoundedText),
  node: Schema.optionalKey(NewNode),
  parameters: Schema.optionalKey(JsonObject),
  replace: Schema.optionalKey(Schema.Boolean),
  path: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(1_024), Schema.isPattern(/^\//u)),
  ),
  value: Schema.optionalKey(Schema.Unknown),
  oldName: Schema.optionalKey(BoundedText),
  newName: Schema.optionalKey(BoundedText),
  source: Schema.optionalKey(ConnectionFields.source),
  target: Schema.optionalKey(ConnectionFields.target),
  sourceIndex: ConnectionFields.sourceIndex,
  targetIndex: ConnectionFields.targetIndex,
  connectionType: ConnectionFields.connectionType,
  credentialKey: Schema.optionalKey(BoundedText),
  credentialId: Schema.optionalKey(BoundedId),
  credentialName: Schema.optionalKey(BoundedText),
  position: Schema.optionalKey(NodePosition),
  disabled: Schema.optionalKey(Schema.Boolean),
  settings: Schema.optionalKey(UpdateSettings),
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
  names: Schema.optionalKey(
    Schema.Array(BoundedText).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
  nodeGroups: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(BoundedId),
        name: BoundedText,
        nodeNames: Schema.Array(BoundedText).check(Schema.isMaxLength(250)),
        description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_000))),
      }),
    ).check(Schema.isMaxLength(100)),
  ),
  groupName: Schema.optionalKey(BoundedText),
  nodeNames: Schema.optionalKey(
    Schema.Array(BoundedText).check(Schema.isMinLength(1), Schema.isMaxLength(250)),
  ),
  id: Schema.optionalKey(BoundedId),
});
const UpdateWorkflowInput = Schema.Struct({
  workflowId: BoundedId,
  skillsUsed: SkillsUsed,
  versionName: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  ),
  versionDescription: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_000))),
  operations: Schema.Array(UpdateOperation).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
const SearchDataTablesInput = Schema.Struct({
  query: OptionalQuery,
  projectId: OptionalProjectId,
  limit: OptionalLimit100,
});
const ColumnType = Schema.Literals(["string", "number", "boolean", "date"]);
const ColumnName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(63),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*$/u),
);
const CreateDataTableInput = Schema.Struct({
  projectId: BoundedId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  columns: Schema.Array(Schema.Struct({ name: ColumnName, type: ColumnType })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(250),
  ),
});
const DataTableIdentity = { dataTableId: BoundedId, projectId: BoundedId } as const;
const AddDataTableColumnInput = Schema.Struct({
  ...DataTableIdentity,
  name: ColumnName,
  type: ColumnType,
});
const RenameDataTableColumnInput = Schema.Struct({
  ...DataTableIdentity,
  columnId: BoundedId,
  name: ColumnName,
});
const DeleteDataTableColumnInput = Schema.Struct({
  ...DataTableIdentity,
  columnId: BoundedId,
});
const RenameDataTableInput = Schema.Struct({
  ...DataTableIdentity,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
const DataTableScalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]);
const AddDataTableRowsInput = Schema.Struct({
  ...DataTableIdentity,
  rows: Schema.Array(Schema.Record(ColumnName, DataTableScalar)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_000),
  ),
});

export interface ReviewedTool extends IntegrationProviderTool {
  readonly upstreamName: string;
  readonly capability: (typeof CAPABILITIES)[number];
  /** n8n's own readOnlyHint, which drift detection compares against. */
  readonly upstreamReadOnly: boolean;
}

function reviewedTool(
  upstreamName: string,
  description: string,
  input: Schema.Decoder<unknown>,
  capability: ReviewedTool["capability"],
  options: {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
    readonly idempotent?: boolean;
    readonly openWorld?: boolean;
    /** Route a call n8n marks read-only through Harness write approval anyway. */
    readonly requireApproval?: boolean;
  } = {},
): ReviewedTool {
  const readOnly = options.readOnly ?? true;
  return {
    name: `n8n.${upstreamName}`,
    upstreamName,
    description,
    input,
    capability,
    readOnly: readOnly && options.requireApproval !== true,
    upstreamReadOnly: readOnly,
    destructive: options.destructive ?? false,
    idempotent: options.idempotent ?? readOnly,
    openWorld: options.openWorld ?? false,
  };
}

const HAND_REVIEWED_TOOLS = [
  reviewedTool(
    "search_workflows",
    "Search workflow previews visible to the connected n8n user.",
    SearchWorkflowsInput,
    "read",
  ),
  reviewedTool(
    "get_workflow_details",
    "Read one accessible workflow with sanitized nodes and trigger guidance.",
    WorkflowDetailsInput,
    "read",
  ),
  reviewedTool(
    "get_workflow_history",
    "Read bounded version history for one accessible workflow.",
    WorkflowHistoryInput,
    "read",
  ),
  reviewedTool(
    "get_workflow_version",
    "Read one exact historical workflow version.",
    WorkflowVersionInput,
    "read",
  ),
  reviewedTool(
    "execute_workflow",
    "Execute an accessible workflow in manual or production mode.",
    ExecuteWorkflowInput,
    "write",
    { readOnly: false, destructive: true, idempotent: false, openWorld: true },
  ),
  reviewedTool(
    "test_workflow",
    "Test workflow logic with bounded pin data.",
    TestWorkflowInput,
    "write",
    { readOnly: false, destructive: true, idempotent: false },
  ),
  reviewedTool(
    "prepare_workflow_pin_data",
    "Prepare pin-data schemas for testing one workflow.",
    WorkflowIdInput,
    "write",
  ),
  reviewedTool(
    "publish_workflow",
    "Publish an accessible workflow version.",
    PublishWorkflowInput,
    "write",
    { readOnly: false, idempotent: true },
  ),
  reviewedTool(
    "unpublish_workflow",
    "Unpublish an accessible workflow.",
    WorkflowIdInput,
    "write",
    { readOnly: false, idempotent: true },
  ),
  reviewedTool(
    "search_projects",
    "Search projects visible to the connected n8n user.",
    SearchProjectsInput,
    "read",
  ),
  reviewedTool(
    "search_folders",
    "Search folders within one accessible project.",
    SearchFoldersInput,
    "read",
  ),
  reviewedTool("list_workflow_tags", "List available workflow tags.", ListTagsInput, "read"),
  reviewedTool(
    "get_workflow_execution",
    "Read one accessible execution with optionally bounded result data.",
    GetExecutionInput,
    "read",
  ),
  reviewedTool(
    "search_workflow_executions",
    "Search accessible workflow executions.",
    SearchExecutionsInput,
    "read",
  ),
  reviewedTool(
    "list_credentials",
    "List accessible credential names and metadata without secret values.",
    ListCredentialsInput,
    "read",
  ),
  reviewedTool(
    "list_n8n_gateway_services",
    "List n8n Gateway managed-credential coverage without credential values.",
    EmptyInput,
    "read",
  ),
  reviewedTool(
    "get_workflow_sdk_reference",
    "Read reviewed n8n Workflow SDK reference material.",
    GetSdkReferenceInput,
    "read",
  ),
  reviewedTool(
    "search_nodes",
    "Search n8n node types by bounded queries.",
    SearchNodesInput,
    "read",
  ),
  reviewedTool(
    "get_node_types",
    "Read exact TypeScript definitions for selected n8n node types.",
    GetNodeTypesInput,
    "read",
  ),
  reviewedTool(
    "get_workflow_best_practices",
    "Read n8n best practices for a workflow technique.",
    BestPracticesInput,
    "read",
  ),
  reviewedTool(
    "explore_node_resources",
    "Resolve resources for one node using an accessible credential.",
    ExploreNodeResourcesInput,
    "read",
    { openWorld: true },
  ),
  reviewedTool(
    "validate_workflow",
    "Validate bounded Workflow SDK code without saving it.",
    ValidateWorkflowInput,
    "read",
  ),
  reviewedTool(
    "validate_node_config",
    "Validate bounded node configurations without saving them.",
    ValidateNodeConfigInput,
    "read",
  ),
  reviewedTool(
    "create_workflow_from_code",
    "Create a workflow from validated Workflow SDK code.",
    CreateWorkflowInput,
    "write",
    { readOnly: false, idempotent: false },
  ),
  reviewedTool(
    "update_workflow",
    "Atomically apply a bounded ordered operation batch to a workflow.",
    UpdateWorkflowInput,
    "write",
    { readOnly: false, destructive: true, idempotent: false },
  ),
  reviewedTool("archive_workflow", "Archive an accessible workflow.", WorkflowIdInput, "write", {
    readOnly: false,
    destructive: true,
    idempotent: true,
  }),
  reviewedTool(
    "restore_workflow_version",
    "Restore an accessible workflow from one exact historical version.",
    WorkflowVersionInput,
    "write",
    { readOnly: false, destructive: true, idempotent: false },
  ),
  reviewedTool(
    "search_data_tables",
    "Search data tables visible to the connected n8n user.",
    SearchDataTablesInput,
    "read",
  ),
  reviewedTool(
    "create_data_table",
    "Create a data table in an accessible project.",
    CreateDataTableInput,
    "write",
    { readOnly: false, idempotent: false },
  ),
  reviewedTool(
    "add_data_table_column",
    "Add a column to an accessible data table.",
    AddDataTableColumnInput,
    "write",
    { readOnly: false, idempotent: false },
  ),
  reviewedTool(
    "rename_data_table_column",
    "Rename a column in an accessible data table.",
    RenameDataTableColumnInput,
    "write",
    { readOnly: false, idempotent: true },
  ),
  reviewedTool(
    "delete_data_table_column",
    "Permanently delete a data-table column and its data.",
    DeleteDataTableColumnInput,
    "write",
    { readOnly: false, destructive: true, idempotent: false },
  ),
  reviewedTool(
    "rename_data_table",
    "Rename an accessible data table.",
    RenameDataTableInput,
    "write",
    { readOnly: false, idempotent: true },
  ),
  reviewedTool(
    "add_data_table_rows",
    "Insert bounded rows into an accessible data table.",
    AddDataTableRowsInput,
    "write",
    { readOnly: false, idempotent: false },
  ),
] as const satisfies ReadonlyArray<ReviewedTool>;

const UPSTREAM_TOOL_BY_NAME = new Map(UPSTREAM_TOOLS.map((tool) => [tool.name, tool]));

// Tools whose input schemas are taken verbatim from the pinned upstream catalog in
// upstream-tools.ts rather than hand-written. Effects mirror n8n's own annotations, and the
// capability follows the scope group that unlocks the tool.
function upstreamTool(
  upstreamName: string,
  description: string,
  capability: ReviewedTool["capability"],
  options: { readonly requireApproval?: boolean } = {},
): ReviewedTool {
  const upstream = UPSTREAM_TOOL_BY_NAME.get(upstreamName);
  if (!upstream) throw new Error(`n8n upstream tool ${upstreamName} is not in the pinned catalog.`);
  return reviewedTool(
    upstreamName,
    description,
    decoderFromJsonSchema(upstream.inputSchema, upstreamName) as Schema.Decoder<unknown>,
    capability,
    {
      readOnly: upstream.annotations.readOnlyHint,
      destructive: upstream.annotations.destructiveHint,
      idempotent: upstream.annotations.idempotentHint,
      openWorld: upstream.annotations.openWorldHint,
      requireApproval: options.requireApproval,
    },
  );
}

const UPSTREAM_REVIEWED_TOOLS = [
  upstreamTool(
    "get_workflow_versions_diff",
    "Compare two saved versions of one accessible workflow.",
    "read",
  ),
  upstreamTool(
    "move_workflows_to_folder",
    "Move accessible workflows into a folder or to the project root.",
    "write",
  ),
  upstreamTool("create_folder", "Create a folder in an accessible project.", "write"),
  upstreamTool("update_folder", "Rename a folder or move it within its project.", "write"),
  upstreamTool(
    "get_data_table_rows",
    "Read filtered, sorted, and paginated rows from an accessible data table.",
    "read",
  ),
  upstreamTool(
    "get_instance_context",
    "Read an overview of accessible workflows, recent changes, and recent runs.",
    "read",
  ),
  upstreamTool(
    "get_instance_activity",
    "Read the activity log of recent workflow and credential changes.",
    "read",
  ),
  upstreamTool(
    "expand_instance_activity",
    "Open one activity log entry with the related history of its resource.",
    "read",
  ),
  upstreamTool("get_node_usage", "Read which node types accessible workflows already use.", "read"),
  upstreamTool(
    "get_user_preferences",
    "Read saved instance, personal, and project building preferences.",
    "read",
  ),
  upstreamTool(
    "install_community_node",
    "Install a verified community node package onto the n8n instance.",
    "write",
  ),
  upstreamTool("search_agents", "Search n8n Agents visible to the connected user.", "read"),
  upstreamTool(
    "get_agent",
    "Read one Agent draft or published version, including its configHash.",
    "read",
  ),
  upstreamTool("list_agent_versions", "List the publish history of one Agent.", "read"),
  upstreamTool(
    "discover_agent_assets",
    "Discover models, integrations, workflows, sub-agents, or MCP servers for an Agent.",
    "read",
  ),
  upstreamTool(
    "validate_agent",
    "Validate an Agent draft and its references without saving.",
    "read",
  ),
  upstreamTool(
    "get_agent_builder_reference",
    "Read the n8n Agent configuration and mutation reference.",
    "read",
  ),
  // n8n marks this read-only, but it connects to a caller-chosen URL using a stored credential, so
  // a prompt could send that credential anywhere. Require the same approval as a write.
  upstreamTool(
    "verify_agent_mcp_server",
    "Test an MCP server with an accessible credential and list its tools.",
    "write",
    { requireApproval: true },
  ),
  upstreamTool("create_agent", "Create an n8n Agent draft.", "write"),
  upstreamTool(
    "mutate_agent",
    "Apply one configuration, skill, task, or custom-tool change to an Agent draft.",
    "write",
  ),
  upstreamTool("revert_agent", "Restore an Agent draft from a published version.", "write"),
  upstreamTool("delete_agent", "Permanently delete an Agent and its resources.", "write"),
  upstreamTool(
    "publish_agent",
    "Publish an Agent draft, or republish one of its earlier versions.",
    "write",
  ),
  upstreamTool(
    "unpublish_agent",
    "Unpublish an Agent and stop its live tasks and integrations.",
    "write",
  ),
  upstreamTool(
    "update_agent_integration",
    "Connect or disconnect an Agent's Slack, Telegram, or Linear integration.",
    "write",
  ),
  upstreamTool(
    "call_agent",
    "Chat with an Agent draft through Preview, using its real tools and credentials.",
    "write",
  ),
];

const REVIEWED_TOOLS: ReadonlyArray<ReviewedTool> = [
  ...HAND_REVIEWED_TOOLS,
  ...UPSTREAM_REVIEWED_TOOLS,
];

export const N8N_TOOLS: ReadonlyArray<IntegrationProviderTool> = REVIEWED_TOOLS;

interface OAuthDiscovery {
  readonly issuer: string;
  /** Reviewed scopes the instance currently offers, in request order. */
  readonly scopes: ReadonlyArray<string>;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
  readonly revocationEndpoint: string;
}

interface Credential {
  readonly version: 1;
  readonly serverUrl: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly scopes: ReadonlyArray<string>;
  readonly updatedAt: string;
}

interface AccessToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly clientId: string;
  readonly discovery: OAuthDiscovery;
}

interface AuthorizationCodeResult {
  readonly kind: "code";
  readonly code: string;
}

interface AuthorizationErrorResult {
  readonly kind: "error";
  readonly error: string;
}

interface PendingFlow {
  readonly flowId: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  clientId: string;
  readonly discovery: OAuthDiscovery;
  readonly requestedScopes: ReadonlyArray<string>;
  readonly expiresAt: number;
  readonly generation: number;
  readonly server: NodeHttp.Server;
  timer: NodeJS.Timeout;
  callbackExpiresAt: number | null;
  callback: AuthorizationCodeResult | AuthorizationErrorResult | null;
  consumed: boolean;
  closePromise: Promise<void> | null;
}

type Fetch = typeof globalThis.fetch;

function asRecord(value: unknown, label = "n8n response"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximum: number, label = "n8n response"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

function advertisedScopes(value: unknown, label: string): ReadonlySet<string> {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ADVERTISED_SCOPES ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 128)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return new Set(value as string[]);
}

function validateServerUrl(value: string): URL {
  const normalized = value.trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("n8n requires the reviewed HTTPS MCP server URL.");
  }
  if (
    url.toString() !== REVIEWED_SERVER_URL ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port !== "" ||
    url.hostname !== "n8n.tritonai.ucsd.edu" ||
    url.pathname !== "/mcp-server/http"
  ) {
    throw new Error("n8n requires the reviewed HTTPS MCP server URL.");
  }
  return url;
}

function sameOriginEndpoint(value: unknown, path: string, origin: string, label: string): string {
  const raw = boundedString(value, 2_048, label);
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== origin ||
    endpoint.pathname !== path ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  ) {
    throw new Error(`${label} is outside the reviewed n8n origin.`);
  }
  return endpoint.toString();
}

function parseScopes(
  value: unknown,
  label = "n8n OAuth scope grant",
  allowedScopes: ReadonlySet<string> = OAUTH_SCOPE_SET,
): string[] {
  const values =
    typeof value === "string"
      ? value.split(/\s+/u).filter(Boolean)
      : Array.isArray(value)
        ? value
        : [];
  if (
    values.length === 0 ||
    values.length > allowedScopes.size ||
    values.some((entry) => typeof entry !== "string" || !allowedScopes.has(entry)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`${label} is invalid or broader than the reviewed scope set.`);
  }
  return [...values].toSorted() as string[];
}

// n8n's consent screen lets the user narrow the grant to any subset of the requested scopes, and
// n8n then lists only the tools that subset unlocks. Reflect whichever kinds of access remain
// rather than insisting on a fixed bundle; the upstream tool list stays the enforcement point.
function capabilitiesFromScopes(scopes: ReadonlyArray<string>): ReadonlyArray<string> {
  const capabilities: string[] = [];
  if (scopes.some((scope) => READ_OAUTH_SCOPE_SET.has(scope))) capabilities.push("read");
  if (scopes.some((scope) => WRITE_OAUTH_SCOPE_SET.has(scope))) capabilities.push("write");
  return capabilities;
}

function scopesForCapabilities(capabilities: ReadonlyArray<string>): ReadonlyArray<string> {
  const selected = new Set(capabilities);
  const scopes = new Set<string>();
  if (selected.has("read") || selected.has("write")) {
    for (const scope of READ_OAUTH_SCOPES) scopes.add(scope);
  }
  if (selected.has("write")) {
    for (const scope of WRITE_OAUTH_SCOPES) scopes.add(scope);
  }
  return [...scopes].toSorted();
}

function parseCredential(encoded: string, serverUrl: string): Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("Stored n8n credential is invalid.");
  }
  const value = asRecord(parsed, "Stored n8n credential");
  const allowed = new Set([
    "version",
    "serverUrl",
    "issuer",
    "clientId",
    "refreshToken",
    "scopes",
    "updatedAt",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.version !== 1 ||
    value.serverUrl !== serverUrl ||
    value.issuer !== new URL(serverUrl).origin ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error("Stored n8n credential is invalid.");
  }
  const scopes = parseScopes(value.scopes, "Stored n8n credential scope");
  if (capabilitiesFromScopes(scopes).length === 0) {
    throw new Error("Stored n8n credential has no reviewed scopes.");
  }
  return {
    version: 1,
    serverUrl,
    issuer: value.issuer,
    clientId: boundedString(value.clientId, MAX_CLIENT_ID_CHARS, "Stored n8n credential"),
    refreshToken: boundedString(value.refreshToken, MAX_TOKEN_CHARS, "Stored n8n credential"),
    scopes,
    updatedAt: value.updatedAt,
  };
}

interface PendingRevocation {
  readonly clientId: string;
  readonly refreshToken: string;
}

// Grants are never dropped from this queue before n8n confirms revoking them. It stays bounded
// because a new sign-in is refused while it is full, and each connection adds at most one grant.
const MAX_PENDING_REVOCATIONS = 16;

// Recovers every usable grant from the stored queue, whatever envelope wrote it, so a record from
// another plugin version is retried rather than discarded. Only bytes that are not JSON at all
// yield nothing: they hold no token that could still be revoked.
function parsePendingRevocations(encoded: string): PendingRevocation[] {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return [];
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const entries = record
    ? Array.isArray((record as Record<string, unknown>).grants)
      ? ((record as Record<string, unknown>).grants as unknown[])
      : [record]
    : Array.isArray(value)
      ? value
      : [];
  const grants: PendingRevocation[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { clientId, refreshToken } = entry as Record<string, unknown>;
    if (
      typeof clientId === "string" &&
      clientId.length > 0 &&
      clientId.length <= MAX_CLIENT_ID_CHARS &&
      typeof refreshToken === "string" &&
      refreshToken.length > 0 &&
      refreshToken.length <= MAX_TOKEN_CHARS &&
      !grants.some((grant) => grant.refreshToken === refreshToken)
    ) {
      grants.push({ clientId, refreshToken });
    }
  }
  return grants;
}

async function readResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("n8n response exceeded the allowed size.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("n8n response exceeded the allowed size.");
      }
      chunks.push(value);
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
  return bytes;
}

function parseJson(bytes: Uint8Array, label = "n8n response"): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(decoder.decode(bytes)), label);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} contained invalid JSON.`);
  }
}

function parseMcpPayload(response: Response, bytes: Uint8Array): Record<string, unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) return parseJson(bytes, "n8n MCP response");
  if (!contentType.includes("text/event-stream")) {
    throw new Error("n8n MCP returned an invalid content type.");
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error("n8n MCP returned invalid event-stream text.");
  }
  text = text.replace(/\r\n?/gu, "\n");
  if (text.length === 0) {
    throw new Error("n8n MCP returned an invalid event stream.");
  }
  const events = text
    .split("\n\n")
    .filter((block) => block.split("\n").some((line) => line !== "" && !line.startsWith(":")));
  if (events.length !== 1) throw new Error("n8n MCP returned an ambiguous event stream.");
  const lines = events[0]!.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      if (line.slice(6).trim() !== "message") {
        throw new Error("n8n MCP returned an unsupported event type.");
      }
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    if (line.trim() === "" || line.startsWith("id:") || line.startsWith("retry:")) continue;
    throw new Error("n8n MCP returned an invalid event stream.");
  }
  if (dataLines.length === 0) throw new Error("n8n MCP event stream omitted response data.");
  return parseJson(encoder.encode(dataLines.join("\n")), "n8n MCP response");
}

function randomBase64Url(bytes: number): string {
  return NodeCrypto.randomBytes(bytes).toString("base64url");
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    NodeCrypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

function assertJsonBounds(value: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new IntegrationProviderPublicError("n8n tool input must be bounded JSON data.");
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_INPUT_BYTES) {
    throw new IntegrationProviderPublicError("n8n tool input exceeds the two-megabyte limit.");
  }
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new IntegrationProviderPublicError("n8n tool input is too deeply nested or complex.");
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) {
      throw new IntegrationProviderPublicError("n8n tool input must not contain cycles.");
    }
    seen.add(current.value);
    if (
      !Array.isArray(current.value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(current.value))
    ) {
      throw new IntegrationProviderPublicError("n8n tool input must contain only JSON objects.");
    }
    for (const child of Object.values(current.value)) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

// Compare the structural wire contract only. Descriptions, titles, additionalProperties, and
// defensive validation bounds are intentionally local because equivalent Effect and n8n schemas
// encode them differently; the local bounded decoder remains authoritative for accepted inputs.
const STRUCTURAL_SCHEMA_KEYS = new Set([
  "$ref",
  "anyOf",
  "enum",
  "items",
  "oneOf",
  "properties",
  "required",
  "type",
]);

function resolveLocalSchemaReference(root: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) return undefined;
  let current = root;
  for (const encodedSegment of reference.slice(2).split("/")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function schemaContract(
  value: unknown,
  root: unknown = value,
  activeReferences: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => schemaContract(entry, root, activeReferences));
    return mapped.every((entry) => typeof entry === "string")
      ? (mapped as string[]).toSorted()
      : mapped;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string" && !activeReferences.has(record.$ref)) {
    const resolved = resolveLocalSchemaReference(root, record.$ref);
    if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
      const siblings = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "$ref"));
      return schemaContract(
        { ...(resolved as Record<string, unknown>), ...siblings },
        root,
        new Set([...activeReferences, record.$ref]),
      );
    }
  }
  // zod emits stacked refinements as allOf members, which may carry the only `type`. Fold them
  // into the parent so they compare equal to a single constrained schema. A composition that
  // cannot be folded without losing a constraint stays visible, so it never matches a pinned
  // contract and the tool is paused as drift.
  if (Array.isArray(record.allOf)) {
    const { allOf, ...rest } = record;
    const merged = mergeAllOfMembers(rest, allOf as unknown[]);
    if (merged) return schemaContract(merged, root, activeReferences);
    return {
      ...(schemaContract(rest, root, activeReferences) as Record<string, unknown>),
      allOf: (allOf as unknown[]).map((member) => schemaContract(member, root, activeReferences)),
    };
  }
  // A type list is the same contract as a union of single-type members.
  if (Array.isArray(record.type) && !("anyOf" in record)) {
    const { type, ...rest } = record;
    return schemaContract(
      { ...rest, anyOf: (type as unknown[]).map((entry) => ({ type: entry })) },
      root,
      activeReferences,
    );
  }
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record)
    .filter((entry) => STRUCTURAL_SCHEMA_KEYS.has(entry))
    .toSorted()) {
    if (key === "properties") {
      const properties = record.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
      normalized.properties = Object.fromEntries(
        Object.keys(properties)
          .toSorted()
          .map((name) => [
            name,
            schemaContract((properties as Record<string, unknown>)[name], root, activeReferences),
          ]),
      );
      continue;
    }
    normalized[key] = schemaContract(record[key], root, activeReferences);
  }
  if ("const" in record && !("enum" in record)) {
    normalized.enum = [schemaContract(record.const, root, activeReferences)];
  }
  if (
    normalized.properties &&
    typeof normalized.properties === "object" &&
    !Array.isArray(normalized.properties) &&
    Object.keys(normalized.properties).length === 0
  ) {
    delete normalized.properties;
  }
  // `items: {}` admits any element, exactly like omitting `items`.
  if (
    normalized.items &&
    typeof normalized.items === "object" &&
    !Array.isArray(normalized.items) &&
    Object.keys(normalized.items).length === 0
  ) {
    delete normalized.items;
  }
  if (Array.isArray(record.prefixItems) && !("type" in normalized)) {
    normalized.type = "array";
  }
  if (
    Array.isArray(normalized.anyOf) &&
    normalized.anyOf.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).type === "string" &&
        Array.isArray((entry as Record<string, unknown>).enum) &&
        ((entry as Record<string, unknown>).enum as unknown[]).every(
          (value) => typeof value === "string",
        ) &&
        Object.keys(entry as Record<string, unknown>).every(
          (key) => key === "type" || key === "enum",
        ),
    )
  ) {
    normalized.type = "string";
    normalized.enum = [
      ...new Set(
        normalized.anyOf.flatMap((entry) => (entry as { readonly enum: readonly string[] }).enum),
      ),
    ].toSorted();
    delete normalized.anyOf;
  }
  return normalized;
}

export function firstSchemaDifference(
  actual: unknown,
  expected: unknown,
  path = "$",
): { readonly path: string; readonly actual: unknown; readonly expected: unknown } | null {
  if (Object.is(actual, expected)) return null;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      return { path: `${path}.length`, actual: actual.length, expected: expected.length };
    }
    for (let index = 0; index < actual.length; index += 1) {
      const difference = firstSchemaDifference(actual[index], expected[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (
    actual &&
    expected &&
    typeof actual === "object" &&
    typeof expected === "object" &&
    !Array.isArray(actual) &&
    !Array.isArray(expected)
  ) {
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const keys = [
      ...new Set([...Object.keys(actualRecord), ...Object.keys(expectedRecord)]),
    ].toSorted();
    for (const key of keys) {
      if (!(key in actualRecord) || !(key in expectedRecord)) {
        return {
          path: `${path}.${key}`,
          actual: actualRecord[key] ?? "<missing>",
          expected: expectedRecord[key] ?? "<missing>",
        };
      }
      const difference = firstSchemaDifference(
        actualRecord[key],
        expectedRecord[key],
        `${path}.${key}`,
      );
      if (difference) return difference;
    }
    return null;
  }
  return { path, actual, expected };
}

export function expectedSchema(tool: Pick<ReviewedTool, "input">): unknown {
  const document = Schema.toJsonSchemaDocument(tool.input);
  return Object.keys(document.definitions).length > 0
    ? { ...document.schema, $defs: document.definitions }
    : document.schema;
}

interface ToolInventory {
  readonly available: ReadonlySet<string>;
  readonly paused: ReadonlyArray<string>;
}

// n8n evolves its MCP catalog between releases. A reviewed tool whose input schema or effect
// hints drifted is paused on its own, failing closed for that tool only, so one upstream change
// does not take the whole connection down. Tools the plugin has not reviewed stay unavailable
// until a plugin update exposes them.
export function validateToolInventory(value: unknown): ToolInventory {
  const result = asRecord(value, "n8n MCP tools/list result");
  if (!Array.isArray(result.tools) || result.tools.length > MAX_MCP_TOOLS) {
    throw new Error("n8n MCP tool inventory is invalid.");
  }
  const actual = new Map<string, Record<string, unknown>>();
  for (const raw of result.tools) {
    const tool = asRecord(raw, "n8n MCP tool definition");
    const name = boundedString(tool.name, 128, "n8n MCP tool name");
    if (actual.has(name)) throw new Error("n8n MCP returned duplicate tools.");
    actual.set(name, tool);
  }
  const available = new Set<string>();
  const paused: string[] = [];
  for (const reviewed of REVIEWED_TOOLS) {
    const upstream = actual.get(reviewed.upstreamName);
    if (!upstream) continue;
    const upstreamContract = schemaContract(upstream.inputSchema);
    const reviewedContract = schemaContract(expectedSchema(reviewed));
    const annotations = upstream.annotations;
    const hints =
      annotations && typeof annotations === "object" && !Array.isArray(annotations)
        ? (annotations as Record<string, unknown>)
        : null;
    if (
      !NodeUtil.isDeepStrictEqual(upstreamContract, reviewedContract) ||
      !hints ||
      hints.readOnlyHint !== reviewed.upstreamReadOnly ||
      hints.destructiveHint !== reviewed.destructive ||
      hints.idempotentHint !== reviewed.idempotent ||
      hints.openWorldHint !== reviewed.openWorld
    ) {
      paused.push(reviewed.upstreamName);
      continue;
    }
    available.add(reviewed.upstreamName);
  }
  if (available.size === 0) {
    throw new IntegrationProviderPublicError(
      paused.length > 0
        ? `n8n MCP changed every reviewed tool this account can use (${paused.join(", ")}). Update the TritonAI n8n plugin before use.`
        : "n8n MCP no longer offers any tools from the reviewed catalog. Update the TritonAI n8n plugin before use.",
    );
  }
  return { available, paused: paused.toSorted() };
}

class SessionInvalidError extends Error {}
class ConfirmedRemoteFailure extends IntegrationProviderPublicError {}

export class N8nProvider implements IntegrationProvider {
  readonly id = N8N_PROVIDER_ID;
  readonly tools = N8N_TOOLS;
  readonly #secrets: IntegrationSecretStore;
  readonly #server: URL;
  readonly #fetch: Fetch;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingFlow>();
  readonly #polling = new Set<string>();
  readonly #requestControllers = new Set<AbortController>();
  #accessToken: AccessToken | null = null;
  #sessionId: string | null = null;
  #sessionVerified = false;
  #availableTools: ReadonlySet<string> = new Set();
  #pausedTools: ReadonlyArray<string> = [];
  #generation = 0;
  #connectAttempt = 0;
  #credentialRevision = 0;
  #rpcSequence = 0;
  #closed = false;
  #disconnecting = false;
  #uncertainCredentialState = false;
  #credentialMutation: Promise<void> = Promise.resolve();
  #sessionMutation: Promise<void> = Promise.resolve();

  constructor(
    secrets: IntegrationSecretStore,
    configuration: N8nConfiguration,
    fetchImplementation: Fetch = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.#secrets = secrets;
    this.#server = validateServerUrl(configuration.serverUrl);
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
      throw new Error("n8n requires a bounded request timeout.");
    }
    this.#fetch = fetchImplementation;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  #serializeCredential<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#credentialMutation.then(operation, operation);
    this.#credentialMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #serializeSession<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#sessionMutation.then(operation, operation);
    this.#sessionMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #request(
    url: string,
    init: RequestInit,
    maximumBytes: number,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<{ readonly response: Response; readonly bytes: Uint8Array }> {
    if (this.#closed) throw new Error("n8n provider is closed.");
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch {
      throw new Error("n8n request endpoint is invalid.");
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.origin !== this.#server.origin ||
      endpoint.username !== "" ||
      endpoint.password !== ""
    ) {
      throw new Error("n8n request endpoint is outside the reviewed origin.");
    }
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    this.#requestControllers.add(controller);
    const signals = [controller.signal, timeoutSignal];
    if (init.signal) signals.push(init.signal);
    try {
      const response = await this.#fetch(endpoint.toString(), {
        ...init,
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
      return { response, bytes: await readResponseBytes(response, maximumBytes) };
    } catch (error) {
      if (init.signal?.aborted) {
        throw new IntegrationProviderPublicError("n8n request was cancelled.");
      }
      if (controller.signal.aborted || this.#closed) {
        throw new Error("n8n provider was closed.", { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new IntegrationProviderPublicError("n8n request timed out.");
      }
      throw error;
    } finally {
      this.#requestControllers.delete(controller);
    }
  }

  async #requestJson(
    url: string,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<{ readonly response: Response; readonly json: Record<string, unknown> }> {
    const { response, bytes } = await this.#request(url, init, maximumBytes);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error("n8n OAuth endpoint returned an invalid content type.");
    }
    return { response, json: parseJson(bytes) };
  }

  async #discover(signal?: AbortSignal): Promise<OAuthDiscovery> {
    const protectedUrl = new URL(
      `/.well-known/oauth-protected-resource${this.#server.pathname}`,
      this.#server.origin,
    );
    const { response: protectedResponse, json: resource } = await this.#requestJson(
      protectedUrl.toString(),
      { method: "GET", headers: { accept: "application/json" }, signal: signal ?? null },
      METADATA_RESPONSE_BYTES,
    );
    if (!protectedResponse.ok) throw new Error("n8n OAuth protected-resource discovery failed.");
    if (resource.resource !== this.#server.toString()) {
      throw new Error("n8n OAuth resource metadata did not bind the configured server.");
    }
    if (
      !Array.isArray(resource.bearer_methods_supported) ||
      resource.bearer_methods_supported.length !== 1 ||
      resource.bearer_methods_supported[0] !== "header"
    ) {
      throw new Error("n8n OAuth bearer method drifted from the reviewed contract.");
    }
    const resourceScopes = advertisedScopes(
      resource.scopes_supported,
      "n8n OAuth resource scope metadata",
    );
    if (
      !Array.isArray(resource.authorization_servers) ||
      resource.authorization_servers.length !== 1
    ) {
      throw new Error("n8n OAuth authorization server metadata is invalid.");
    }
    const issuer = sameOriginEndpoint(
      resource.authorization_servers[0],
      "/",
      this.#server.origin,
      "n8n OAuth authorization server",
    ).replace(/\/$/u, "");
    const metadataUrl = new URL("/.well-known/oauth-authorization-server", issuer);
    const { response, json } = await this.#requestJson(
      metadataUrl.toString(),
      { method: "GET", headers: { accept: "application/json" }, signal: signal ?? null },
      METADATA_RESPONSE_BYTES,
    );
    if (!response.ok || json.issuer !== issuer) {
      throw new Error("n8n OAuth authorization metadata is invalid.");
    }
    const authorizationScopes = advertisedScopes(
      json.scopes_supported,
      "n8n OAuth authorization scope metadata",
    );
    const scopes = OAUTH_SCOPES.filter(
      (scope) => resourceScopes.has(scope) && authorizationScopes.has(scope),
    );
    if (scopes.length === 0) {
      throw new IntegrationProviderPublicError(
        "n8n no longer offers any access this plugin supports. Update the TritonAI n8n plugin.",
      );
    }
    if (
      !Array.isArray(json.response_types_supported) ||
      !json.response_types_supported.includes("code") ||
      !Array.isArray(json.grant_types_supported) ||
      !json.grant_types_supported.includes("authorization_code") ||
      !json.grant_types_supported.includes("refresh_token") ||
      !Array.isArray(json.token_endpoint_auth_methods_supported) ||
      !json.token_endpoint_auth_methods_supported.includes("none") ||
      !Array.isArray(json.code_challenge_methods_supported) ||
      !json.code_challenge_methods_supported.includes("S256") ||
      json.authorization_response_iss_parameter_supported !== true
    ) {
      throw new Error("n8n OAuth protocol metadata drifted from the reviewed contract.");
    }
    return {
      issuer,
      scopes,
      authorizationEndpoint: sameOriginEndpoint(
        json.authorization_endpoint,
        "/mcp-oauth/authorize",
        this.#server.origin,
        "n8n OAuth authorization endpoint",
      ),
      tokenEndpoint: sameOriginEndpoint(
        json.token_endpoint,
        "/mcp-oauth/token",
        this.#server.origin,
        "n8n OAuth token endpoint",
      ),
      registrationEndpoint: sameOriginEndpoint(
        json.registration_endpoint,
        "/mcp-oauth/register",
        this.#server.origin,
        "n8n OAuth registration endpoint",
      ),
      revocationEndpoint: sameOriginEndpoint(
        json.revocation_endpoint,
        "/mcp-oauth/revoke",
        this.#server.origin,
        "n8n OAuth revocation endpoint",
      ),
    };
  }

  async #registerClient(
    discovery: OAuthDiscovery,
    redirectUri: string,
    signal: AbortSignal,
  ): Promise<string> {
    const request = {
      client_name: "TritonAI Harness n8n plugin",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    const { response, json } = await this.#requestJson(
      discovery.registrationEndpoint,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      },
      METADATA_RESPONSE_BYTES,
    );
    if (response.status !== 200 && response.status !== 201) {
      throw new ConfirmedRemoteFailure("n8n could not register this local OAuth client.");
    }
    if (
      json.client_secret !== undefined ||
      (json.token_endpoint_auth_method !== undefined &&
        json.token_endpoint_auth_method !== "none") ||
      (json.redirect_uris !== undefined &&
        (!Array.isArray(json.redirect_uris) ||
          json.redirect_uris.length !== 1 ||
          json.redirect_uris[0] !== redirectUri)) ||
      (json.grant_types !== undefined &&
        (!Array.isArray(json.grant_types) ||
          !json.grant_types.includes("authorization_code") ||
          !json.grant_types.includes("refresh_token"))) ||
      (json.response_types !== undefined &&
        (!Array.isArray(json.response_types) || !json.response_types.includes("code")))
    ) {
      throw new Error("n8n dynamic client registration output is unsafe.");
    }
    return boundedString(json.client_id, MAX_CLIENT_ID_CHARS, "n8n dynamic client registration");
  }

  async #readCredential(signal?: AbortSignal): Promise<Credential | null> {
    if (signal?.aborted) throw new IntegrationProviderPublicError("n8n request was cancelled.");
    const value = await this.#secrets.get(N8N_SECRET_SUFFIX);
    if (signal?.aborted) throw new IntegrationProviderPublicError("n8n request was cancelled.");
    return value === null ? null : parseCredential(value, this.#server.toString());
  }

  async #writeCredential(
    credential: Credential,
    signal: AbortSignal,
    onPersisted?: () => void,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.#secrets.set(N8N_SECRET_SUFFIX, JSON.stringify(credential));
    onPersisted?.();
    signal.throwIfAborted();
  }

  async #beginCommit(context?: IntegrationLifecycleContext): Promise<AbortSignal> {
    if (!context || typeof context.beginCommit !== "function") {
      throw new Error("n8n credential mutation requires Harness commit admission.");
    }
    return context.beginCommit();
  }

  async #closeFlowListener(flow: PendingFlow, clearExpiryTimer: boolean): Promise<void> {
    if (clearExpiryTimer) clearTimeout(flow.timer);
    if (flow.closePromise) {
      if (clearExpiryTimer) flow.server.closeAllConnections();
      return flow.closePromise;
    }
    flow.closePromise = new Promise<void>((resolve) => {
      if (!flow.server.listening) {
        resolve();
        return;
      }
      flow.server.close(() => resolve());
      flow.server.closeIdleConnections();
      if (clearExpiryTimer) flow.server.closeAllConnections();
    });
    return flow.closePromise;
  }

  async #removeFlow(flowId: string): Promise<void> {
    const flow = this.#pending.get(flowId);
    if (!flow) return;
    this.#pending.delete(flowId);
    await this.#closeFlowListener(flow, true);
  }

  async #clearPendingFlows(): Promise<void> {
    const flows = [...this.#pending.values()];
    this.#pending.clear();
    await Promise.all(flows.map((flow) => this.#closeFlowListener(flow, true)));
  }

  #writeCallbackPage(response: NodeHttp.ServerResponse, status: number, message: string): void {
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>TritonAI Harness</title></head><body><main><h1>${message}</h1><p>You can close this window and return to TritonAI Harness.</p></main></body></html>`;
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      connection: "close",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  #handleCallback(
    flow: PendingFlow,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ): void {
    const address = flow.server.address();
    const expectedHost = address && typeof address === "object" ? `127.0.0.1:${address.port}` : "";
    const remote = request.socket.remoteAddress;
    if (
      request.method !== "GET" ||
      request.headers.host !== expectedHost ||
      (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") ||
      flow.expiresAt <= Date.now() ||
      flow.generation !== this.#generation ||
      this.#closed ||
      this.#disconnecting ||
      this.#pending.get(flow.flowId) !== flow
    ) {
      this.#writeCallbackPage(response, 400, "This n8n sign-in callback is not valid.");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", `http://${expectedHost}`);
    } catch {
      this.#writeCallbackPage(response, 400, "This n8n sign-in callback is not valid.");
      return;
    }
    const allowed = new Set([
      "state",
      "iss",
      "code",
      "scope",
      "error",
      "error_description",
      "error_uri",
    ]);
    if (
      url.pathname !== CALLBACK_PATH ||
      [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
      [...new Set(url.searchParams.keys())].some(
        (key) => url.searchParams.getAll(key).length !== 1,
      ) ||
      url.searchParams.get("iss") !== flow.discovery.issuer ||
      !timingSafeTextEqual(url.searchParams.get("state") ?? "", flow.state) ||
      flow.consumed
    ) {
      this.#writeCallbackPage(response, 400, "This n8n sign-in callback is not valid.");
      return;
    }
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    if ((code === null) === (oauthError === null)) {
      this.#writeCallbackPage(response, 400, "This n8n sign-in callback is not valid.");
      return;
    }
    if (code !== null) {
      if (code.length === 0 || code.length > MAX_TOKEN_CHARS) {
        this.#writeCallbackPage(response, 400, "This n8n sign-in callback is not valid.");
        return;
      }
      flow.consumed = true;
      flow.callback = { kind: "code", code };
      flow.callbackExpiresAt = Date.now() + FLOW_CALLBACK_CLAIM_MS;
      clearTimeout(flow.timer);
      flow.timer = setTimeout(() => {
        if (this.#pending.get(flow.flowId) === flow && !this.#polling.has(flow.flowId)) {
          this.#pending.delete(flow.flowId);
          void this.#closeFlowListener(flow, true);
        }
      }, FLOW_CALLBACK_CLAIM_MS);
      flow.timer.unref();
      this.#writeCallbackPage(response, 200, "n8n sign-in received.");
    } else {
      flow.consumed = true;
      flow.callback = {
        kind: "error",
        error: oauthError && oauthError.length <= 256 ? oauthError : "authorization_denied",
      };
      this.#writeCallbackPage(response, 200, "n8n sign-in was not completed.");
    }
    response.once("finish", () => void this.#closeFlowListener(flow, false));
  }

  async #startFlowListener(
    input: Omit<
      PendingFlow,
      | "server"
      | "timer"
      | "redirectUri"
      | "clientId"
      | "callbackExpiresAt"
      | "callback"
      | "consumed"
      | "closePromise"
    >,
    signal?: AbortSignal,
  ): Promise<PendingFlow> {
    let flow: PendingFlow | null = null;
    const server = NodeHttp.createServer((request, response) => {
      if (!flow) {
        this.#writeCallbackPage(response, 503, "This n8n sign-in callback is not ready.");
        return;
      }
      this.#handleCallback(flow, request, response);
    });
    server.maxHeadersCount = 32;
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 1;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("n8n loopback listener did not bind safely.");
    }
    const timer = setTimeout(
      () => {
        if (this.#pending.get(input.flowId) === flow) {
          this.#pending.delete(input.flowId);
          if (flow) void this.#closeFlowListener(flow, true);
        }
      },
      Math.max(1, input.expiresAt - Date.now()),
    );
    timer.unref();
    flow = {
      ...input,
      server,
      timer,
      redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
      clientId: "",
      callbackExpiresAt: null,
      callback: null,
      consumed: false,
      closePromise: null,
    };
    if (signal?.aborted || this.#closed || this.#disconnecting) {
      await this.#closeFlowListener(flow, true);
      throw new IntegrationProviderPublicError("n8n sign-in was cancelled.");
    }
    return flow;
  }

  async #mcpRpc(
    access: AccessToken,
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal,
    maximumBytes: number,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<unknown> {
    const id = `${++this.#rpcSequence}`;
    const metadata = {
      [MCP_PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
      [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
      [MCP_CLIENT_INFO_META_KEY]: MCP_CLIENT_INFO,
    };
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: metadata },
    };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) {
      throw new IntegrationProviderPublicError("n8n MCP request exceeded the allowed size.");
    }
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${access.value}`,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (method === "tools/call") {
      headers["mcp-name"] = boundedString(params?.name, 128, "n8n MCP tool name");
    }
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    const { response, bytes } = await this.#request(
      this.#server.toString(),
      { method: "POST", headers, body, signal },
      maximumBytes,
      timeoutMs,
    );
    if (response.status === 401) {
      this.#accessToken = null;
      this.#sessionId = null;
      this.#sessionVerified = false;
      this.#availableTools = new Set();
      this.#pausedTools = [];
      throw new ConfirmedRemoteFailure("n8n authorization expired. Reconnect if refresh fails.");
    }
    if (response.status === 404 && this.#sessionId) {
      this.#sessionId = null;
      this.#sessionVerified = false;
      throw new SessionInvalidError("n8n MCP session expired.");
    }
    if (!response.ok) {
      if (response.status === 429) {
        throw new ConfirmedRemoteFailure("n8n is rate limiting MCP requests. Try again later.");
      }
      if (response.status === 403) {
        throw new ConfirmedRemoteFailure("n8n denied this operation for the connected user.");
      }
      throw new ConfirmedRemoteFailure(
        `n8n MCP ${method} failed (HTTP ${response.status}). Reconnect and try again.`,
      );
    }
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession !== null) {
      if (
        returnedSession.length === 0 ||
        returnedSession.length > MAX_SESSION_ID_CHARS ||
        !/^[\x21-\x7E]+$/u.test(returnedSession)
      ) {
        throw new Error("n8n MCP returned an invalid session identifier.");
      }
      if (this.#sessionId !== null && this.#sessionId !== returnedSession) {
        throw new Error("n8n MCP changed session identifiers unexpectedly.");
      }
      this.#sessionId = returnedSession;
    }
    const raw = parseMcpPayload(response, bytes);
    if (raw.jsonrpc !== "2.0" || raw.id !== id) {
      throw new Error("n8n MCP returned a mismatched JSON-RPC response.");
    }
    if (raw.error !== undefined) {
      const error = asRecord(raw.error, "n8n MCP JSON-RPC error");
      if (!Number.isInteger(error.code)) throw new Error("n8n MCP returned an invalid error.");
      throw new ConfirmedRemoteFailure("n8n MCP rejected the request.");
    }
    if (!("result" in raw)) throw new Error("n8n MCP response omitted its result.");
    return raw.result;
  }

  async #initializeSession(access: AccessToken, signal: AbortSignal): Promise<void> {
    await this.#serializeSession(async () => {
      if (this.#sessionVerified) return;
      this.#sessionId = null;
      const discover = asRecord(
        await this.#mcpRpc(
          access,
          "server/discover",
          undefined,
          signal,
          MCP_CONTROL_RESPONSE_BYTES,
        ),
        "n8n MCP server/discover result",
      );
      if (
        discover.resultType !== "complete" ||
        !Array.isArray(discover.supportedVersions) ||
        discover.supportedVersions.length > 16 ||
        !discover.supportedVersions.every((version) => typeof version === "string") ||
        !discover.supportedVersions.includes(MCP_PROTOCOL_VERSION) ||
        !discover.capabilities ||
        typeof discover.capabilities !== "object" ||
        Array.isArray(discover.capabilities) ||
        !(discover.capabilities as Record<string, unknown>).tools ||
        typeof (discover.capabilities as Record<string, unknown>).tools !== "object" ||
        Array.isArray((discover.capabilities as Record<string, unknown>).tools)
      ) {
        throw new IntegrationProviderPublicError(
          "n8n MCP protocol changed from the reviewed version.",
        );
      }
      const collected: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_MCP_PAGES; page += 1) {
        const result = asRecord(
          await this.#mcpRpc(
            access,
            "tools/list",
            cursor === undefined ? undefined : { cursor },
            signal,
            MCP_CONTROL_RESPONSE_BYTES,
          ),
          "n8n MCP tools/list result",
        );
        if (result.resultType !== "complete" || !Array.isArray(result.tools)) {
          throw new Error("n8n MCP tool inventory is invalid.");
        }
        collected.push(...result.tools.map((tool) => asRecord(tool, "n8n MCP tool definition")));
        if (collected.length > MAX_MCP_TOOLS)
          throw new Error("n8n MCP tool inventory is too large.");
        if (result.nextCursor === undefined || result.nextCursor === null) {
          cursor = undefined;
          break;
        }
        cursor = boundedString(result.nextCursor, 2_048, "n8n MCP tools cursor");
      }
      if (cursor !== undefined) throw new Error("n8n MCP tool inventory pagination is too large.");
      const inventory = validateToolInventory({ tools: collected });
      this.#availableTools = inventory.available;
      this.#pausedTools = inventory.paused;
      this.#sessionVerified = true;
    });
  }

  async #revokeToken(
    discovery: OAuthDiscovery,
    token: string,
    clientId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { response } = await this.#request(
      discovery.revocationEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          token,
          token_type_hint: "refresh_token",
        }),
        signal,
      },
      METADATA_RESPONSE_BYTES,
    );
    if (!response.ok) {
      throw new ConfirmedRemoteFailure("n8n could not revoke the credential. Try again.");
    }
  }

  #parseTokenResponse(
    json: Record<string, unknown>,
    clientId: string,
    discovery: OAuthDiscovery,
    existingRefreshToken?: string,
    allowedScopes: ReadonlySet<string> = OAUTH_SCOPE_SET,
  ): { readonly credential: Credential; readonly access: AccessToken } {
    if (json.token_type !== "Bearer" && json.token_type !== "bearer") {
      throw new Error("n8n OAuth returned an invalid token type.");
    }
    const accessToken = boundedString(json.access_token, MAX_TOKEN_CHARS, "n8n OAuth access token");
    const refreshToken =
      json.refresh_token === undefined
        ? existingRefreshToken
        : boundedString(json.refresh_token, MAX_TOKEN_CHARS, "n8n OAuth refresh token");
    if (!refreshToken) throw new Error("n8n OAuth did not issue renewable access.");
    const expiresIn = boundedInteger(json.expires_in, 60, 86_400, "n8n OAuth token lifetime");
    const scopes = parseScopes(json.scope, "n8n OAuth scope grant", allowedScopes);
    return {
      credential: {
        version: 1,
        serverUrl: this.#server.toString(),
        issuer: discovery.issuer,
        clientId,
        refreshToken,
        scopes,
        updatedAt: new Date().toISOString(),
      },
      access: {
        value: accessToken,
        expiresAt: Date.now() + expiresIn * 1_000,
        clientId,
        discovery,
      },
    };
  }

  async status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus> {
    if (this.#uncertainCredentialState) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Credential state is uncertain. Disconnect to verify reset before reconnecting.",
      };
    }
    if (this.#closed || this.#disconnecting) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: this.#closed ? "The n8n provider is closed." : "n8n is disconnecting.",
      };
    }
    const generation = this.#generation;
    const revision = this.#credentialRevision;
    try {
      const credential = await this.#readCredential(context?.signal);
      if (
        generation !== this.#generation ||
        revision !== this.#credentialRevision ||
        this.#closed ||
        this.#disconnecting
      ) {
        throw new Error("n8n connection changed during status.");
      }
      if (!credential) {
        const revocationPending = (await this.#secrets.get(N8N_REVOCATION_SECRET_SUFFIX)) !== null;
        return {
          state: this.#pending.size > 0 ? "connecting" : "not_connected",
          accountLabel: null,
          grantedCapabilities: [],
          message: revocationPending
            ? "Disconnected here, but n8n has not confirmed revoking the previous sign-in. It is retried on the next connect or disconnect."
            : null,
        };
      }
      return {
        state: "connected",
        accountLabel: this.#server.hostname,
        grantedCapabilities: capabilitiesFromScopes(credential.scopes),
        message:
          this.#pausedTools.length > 0
            ? `Connected with the n8n user's own permissions. Paused until the plugin is updated because n8n changed them: ${this.#pausedTools.join(", ")}.`
            : "Connected with the n8n user's own permissions.",
      };
    } catch {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "The stored n8n connection could not be verified. Disconnect to reset it.",
      };
    }
  }

  async connect(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<
    | IntegrationAuthorizationUrlConnectResult
    | { readonly kind: "connected"; readonly flowId: string; readonly message: string }
  > {
    if (submission !== undefined)
      throw new Error("n8n browser OAuth rejects credential submissions.");
    if (this.#closed || this.#disconnecting) throw new Error("n8n is unavailable.");
    if (this.#uncertainCredentialState) throw new Error("n8n credential state is uncertain.");
    if (
      capabilities.length === 0 ||
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability) => !CAPABILITY_SET.has(capability))
    ) {
      throw new Error("Unsupported n8n capability.");
    }
    const generation = this.#generation;
    const revision = this.#credentialRevision;
    const attempt = ++this.#connectAttempt;
    const existing = await this.#readCredential(context?.signal);
    if (existing) {
      const granted = capabilitiesFromScopes(existing.scopes);
      if (!capabilities.every((capability) => granted.includes(capability))) {
        throw new IntegrationProviderPublicError(
          "Disconnect and reconnect n8n to approve the additional access.",
        );
      }
      return {
        kind: "connected",
        flowId: NodeCrypto.randomUUID(),
        message: "n8n is already authorized for this user.",
      };
    }
    const discovery = await this.#discover(context?.signal);
    const requestedScopes = scopesForCapabilities(capabilities).filter((scope) =>
      discovery.scopes.includes(scope),
    );
    // Each requested kind of access needs at least one offered scope, or sign-in could only ever
    // produce a narrower connection than the user asked for.
    for (const capability of capabilities) {
      const group = capability === "write" ? WRITE_OAUTH_SCOPE_SET : READ_OAUTH_SCOPE_SET;
      if (!requestedScopes.some((scope) => group.has(scope))) {
        throw new IntegrationProviderPublicError(
          `n8n does not currently offer ${capability} access on this instance.`,
        );
      }
    }
    await this.#clearPendingFlows();
    const flowId = NodeCrypto.randomUUID();
    const state = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const expiresAt = Date.now() + FLOW_LIFETIME_MS;
    const flow = await this.#startFlowListener(
      { flowId, state, codeVerifier, discovery, requestedScopes, expiresAt, generation },
      context?.signal,
    );
    let admitted = false;
    try {
      const commitSignal = await this.#beginCommit(context);
      admitted = true;
      try {
        await this.#retryPendingRevocations(discovery, commitSignal);
      } catch (error) {
        if (commitSignal.aborted) throw error;
      }
      if ((await this.#readPendingRevocations()).length >= MAX_PENDING_REVOCATIONS) {
        throw new ConfirmedRemoteFailure(
          "n8n has not confirmed revoking earlier sign-ins. Try again once n8n accepts revocation.",
        );
      }
      const clientId = await this.#registerClient(discovery, flow.redirectUri, commitSignal);
      if (
        generation !== this.#generation ||
        revision !== this.#credentialRevision ||
        attempt !== this.#connectAttempt ||
        this.#closed ||
        this.#disconnecting
      ) {
        throw new Error("n8n sign-in was superseded while starting.");
      }
      flow.clientId = clientId;
      this.#pending.set(flowId, flow);
    } catch (error) {
      await this.#closeFlowListener(flow, true);
      if (admitted && !(error instanceof ConfirmedRemoteFailure)) {
        this.#uncertainCredentialState = true;
        throw new ExternalCommitOutcomeUnknownError(
          "The n8n OAuth client registration may have completed. Disconnect before retrying.",
        );
      }
      throw error;
    }
    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", flow.clientId);
    authorizationUrl.searchParams.set("redirect_uri", flow.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", requestedScopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set(
      "code_challenge",
      NodeCrypto.createHash("sha256").update(codeVerifier, "ascii").digest("base64url"),
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("resource", this.#server.toString());
    return {
      kind: "authorization_url",
      flowId,
      authorizationUrl: authorizationUrl.toString(),
      message: "Continue in your browser and approve n8n access for your own account.",
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: FLOW_POLL_SECONDS,
    };
  }

  async poll(
    flowId: string,
    context?: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResult> {
    const flow = this.#pending.get(flowId);
    if (!flow) throw new IntegrationProviderPublicError("n8n sign-in flow was not found.");
    if (this.#polling.has(flowId)) {
      throw new IntegrationProviderPublicError("n8n sign-in is already being checked.");
    }
    if (
      flow.callback?.kind === "code"
        ? flow.callbackExpiresAt !== null && flow.callbackExpiresAt <= Date.now()
        : flow.expiresAt <= Date.now()
    ) {
      await this.#removeFlow(flowId);
      return {
        state: "expired",
        retryAfterSeconds: null,
        message: "n8n sign-in expired. Start again.",
      };
    }
    if (flow.callback === null) {
      return {
        state: "pending",
        retryAfterSeconds: FLOW_POLL_SECONDS,
        message: "Waiting for n8n sign-in.",
      };
    }
    if (flow.callback.kind === "error") {
      await this.#removeFlow(flowId);
      return {
        state: "failed",
        retryAfterSeconds: null,
        message:
          flow.callback.error === "access_denied"
            ? "n8n sign-in was cancelled."
            : "n8n sign-in did not complete. Start again.",
      };
    }
    const authorizationCode = flow.callback.code;
    this.#polling.add(flowId);
    try {
      return await this.#serializeCredential(async () => {
        if (
          this.#closed ||
          this.#disconnecting ||
          this.#uncertainCredentialState ||
          flow.generation !== this.#generation ||
          this.#pending.get(flowId) !== flow
        ) {
          throw new Error("n8n sign-in was superseded before token exchange.");
        }
        let admitted = false;
        let responseSettled = false;
        let credentialIssued = false;
        let credentialCompensated = false;
        try {
          const commitSignal = await this.#beginCommit(context);
          admitted = true;
          const { response, json } = await this.#requestJson(
            flow.discovery.tokenEndpoint,
            {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                client_id: flow.clientId,
                code: authorizationCode,
                code_verifier: flow.codeVerifier,
                grant_type: "authorization_code",
                redirect_uri: flow.redirectUri,
                resource: this.#server.toString(),
              }),
              signal: commitSignal,
            },
            TOKEN_RESPONSE_BYTES,
          );
          responseSettled = true;
          if (!response.ok) {
            await this.#removeFlow(flowId);
            return {
              state: "failed",
              retryAfterSeconds: null,
              message: "n8n sign-in failed. Start again.",
            };
          }
          credentialIssued = true;
          const parsed = this.#parseTokenResponse(
            json,
            flow.clientId,
            flow.discovery,
            undefined,
            new Set(flow.requestedScopes),
          );
          if (capabilitiesFromScopes(parsed.credential.scopes).length === 0) {
            await this.#revokeToken(
              flow.discovery,
              parsed.credential.refreshToken,
              parsed.credential.clientId,
              commitSignal,
            );
            credentialCompensated = true;
            await this.#removeFlow(flowId);
            return {
              state: "failed",
              retryAfterSeconds: null,
              message:
                "n8n granted no access this plugin supports. Start again and approve access.",
            };
          }
          this.#accessToken = parsed.access;
          this.#sessionId = null;
          this.#sessionVerified = false;
          this.#availableTools = new Set();
          this.#pausedTools = [];
          try {
            await this.#initializeSession(parsed.access, commitSignal);
          } catch (error) {
            try {
              await this.#revokeToken(
                flow.discovery,
                parsed.credential.refreshToken,
                parsed.credential.clientId,
                commitSignal,
              );
              credentialCompensated = true;
            } catch {
              this.#uncertainCredentialState = true;
            }
            this.#accessToken = null;
            this.#sessionId = null;
            this.#sessionVerified = false;
            this.#availableTools = new Set();
            this.#pausedTools = [];
            await this.#removeFlow(flowId);
            return {
              state: "failed",
              retryAfterSeconds: null,
              message:
                error instanceof IntegrationProviderPublicError
                  ? error.message
                  : "n8n MCP connection verification failed. Try again.",
            };
          }
          if (
            this.#closed ||
            this.#disconnecting ||
            this.#uncertainCredentialState ||
            flow.generation !== this.#generation ||
            this.#pending.get(flowId) !== flow
          ) {
            throw new Error("n8n sign-in was superseded before credential commit.");
          }
          await this.#writeCredential(parsed.credential, commitSignal);
          this.#credentialRevision += 1;
          this.#generation += 1;
          await this.#removeFlow(flowId);
          return {
            state: "connected",
            retryAfterSeconds: null,
            message: "n8n is connected for this user.",
          };
        } catch (error) {
          if (admitted && (!responseSettled || (credentialIssued && !credentialCompensated))) {
            this.#uncertainCredentialState = true;
            throw new ExternalCommitOutcomeUnknownError(
              "The n8n sign-in commit may have completed. Disconnect before retrying.",
            );
          }
          throw error;
        }
      });
    } finally {
      this.#polling.delete(flowId);
    }
  }

  prepare(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serializeCredential(async () => {
      if (this.#closed || this.#disconnecting) throw new Error("n8n is unavailable.");
      if (this.#uncertainCredentialState) throw new Error("n8n credential state is uncertain.");
      const access = this.#accessToken;
      if (access && access.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) {
        await this.#initializeSession(access, context?.signal ?? new AbortController().signal);
        return;
      }
      const generation = this.#generation;
      const revision = this.#credentialRevision;
      const credential = await this.#readCredential(context?.signal);
      if (!credential) return;
      const discovery = await this.#discover(context?.signal);
      if (discovery.issuer !== credential.issuer) {
        throw new Error("n8n OAuth issuer changed from the stored credential.");
      }
      let admitted = false;
      let responseSettled = false;
      let credentialIssued = false;
      let credentialPersisted = false;
      try {
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        const { response, json } = await this.#requestJson(
          discovery.tokenEndpoint,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              client_id: credential.clientId,
              grant_type: "refresh_token",
              refresh_token: credential.refreshToken,
              resource: this.#server.toString(),
              scope: credential.scopes.join(" "),
            }),
            signal: commitSignal,
          },
          TOKEN_RESPONSE_BYTES,
        );
        responseSettled = true;
        if (!response.ok) {
          // invalid_grant means the stored refresh token is gone for good: already spent,
          // revoked, or cleared wholesale when the instance upgraded. Nothing remains to
          // revoke, so drop the dead credential here and let the user reconnect in one
          // step instead of stranding them behind a manual disconnect.
          if (response.status === 400 && json.error === "invalid_grant") {
            await this.#secrets.remove(N8N_SECRET_SUFFIX);
            this.#accessToken = null;
            this.#credentialRevision += 1;
            this.#sessionId = null;
            this.#sessionVerified = false;
            this.#availableTools = new Set();
            this.#pausedTools = [];
            // A known reset must settle admission successfully so Harness permits reconnect.
            return;
          }
          throw new IntegrationProviderPublicError(
            "n8n access could not be refreshed. Disconnect and reconnect.",
          );
        }
        credentialIssued = true;
        const parsed = this.#parseTokenResponse(
          json,
          credential.clientId,
          discovery,
          credential.refreshToken,
          new Set(credential.scopes),
        );
        if (capabilitiesFromScopes(parsed.credential.scopes).length === 0) {
          throw new IntegrationProviderPublicError(
            "n8n refreshed access without any supported scope. Disconnect and reconnect.",
          );
        }
        if (generation !== this.#generation || revision !== this.#credentialRevision) {
          throw new Error("n8n connection changed while refreshing.");
        }
        // n8n rotates refresh tokens and deletes the spent one in the same transaction, so
        // the replacement is the only way back into this grant. Persist it before the MCP
        // session round-trip, which fails routinely on a waking laptop or a restarting
        // instance and would otherwise strand a grant n8n has already moved past.
        await this.#writeCredential(parsed.credential, commitSignal, () => {
          credentialPersisted = true;
          this.#credentialRevision += 1;
          this.#accessToken = parsed.access;
          this.#sessionId = null;
          this.#sessionVerified = false;
          this.#availableTools = new Set();
          this.#pausedTools = [];
        });
        await this.#initializeSession(parsed.access, commitSignal);
      } catch (error) {
        // Harness faults every rejected admitted operation. Settle a durable rotation even
        // when session setup fails; invoke reports the missing session, and the next prepare
        // retries setup before admission using the saved access token.
        if (credentialPersisted) return;
        if (admitted && (!responseSettled || credentialIssued)) {
          this.#uncertainCredentialState = true;
          throw new ExternalCommitOutcomeUnknownError(
            "The n8n credential refresh may have completed. Disconnect before retrying.",
          );
        }
        throw error;
      }
    });
  }

  async #readPendingRevocations(): Promise<PendingRevocation[]> {
    const encoded = await this.#secrets.get(N8N_REVOCATION_SECRET_SUFFIX);
    return encoded === null ? [] : parsePendingRevocations(encoded);
  }

  async #writePendingRevocations(grants: ReadonlyArray<PendingRevocation>): Promise<void> {
    if (grants.length === 0) {
      await this.#secrets.remove(N8N_REVOCATION_SECRET_SUFFIX);
      return;
    }
    await this.#secrets.set(
      N8N_REVOCATION_SECRET_SUFFIX,
      JSON.stringify({
        version: 2,
        serverUrl: this.#server.toString(),
        grants,
      }),
    );
  }

  async #retryPendingRevocations(discovery: OAuthDiscovery, signal: AbortSignal): Promise<void> {
    if ((await this.#secrets.get(N8N_REVOCATION_SECRET_SUFFIX)) === null) return;
    // One shared budget leaves room for registration or local cleanup inside the host's
    // lifecycle deadline, regardless of how many old grants are queued.
    const budget = AbortSignal.timeout(
      Math.min(REVOCATION_RETRY_BUDGET_MS, this.#requestTimeoutMs),
    );
    const retrySignal = AbortSignal.any([signal, budget]);
    const remaining: PendingRevocation[] = [];
    for (const grant of await this.#readPendingRevocations()) {
      if (budget.aborted) {
        remaining.push(grant);
        continue;
      }
      try {
        await this.#revokeToken(discovery, grant.refreshToken, grant.clientId, retrySignal);
      } catch (error) {
        if (signal.aborted) throw error;
        remaining.push(grant);
      }
    }
    await this.#writePendingRevocations(remaining);
  }

  disconnect(context?: IntegrationLifecycleContext): Promise<void> {
    return this.#serializeCredential(async () => {
      this.#disconnecting = true;
      this.#generation += 1;
      this.#connectAttempt += 1;
      this.#sessionId = null;
      this.#sessionVerified = false;
      this.#availableTools = new Set();
      this.#pausedTools = [];
      await this.#clearPendingFlows();
      let admitted = false;
      try {
        // Storage failures propagate. Only a stored value that cannot be parsed counts as
        // unreadable: it cannot be revoked, but it must still be removable because status tells
        // the user to disconnect to reset exactly this state.
        const encoded = await this.#secrets.get(N8N_SECRET_SUFFIX);
        context?.signal?.throwIfAborted();
        let credential: Credential | null = null;
        if (encoded !== null) {
          try {
            credential = parseCredential(encoded, this.#server.toString());
          } catch {
            credential = null;
          }
        }
        const commitSignal = await this.#beginCommit(context);
        admitted = true;
        if (credential) {
          const pending = await this.#readPendingRevocations();
          if (!pending.some((grant) => grant.refreshToken === credential.refreshToken)) {
            if (pending.length >= MAX_PENDING_REVOCATIONS) {
              throw new ConfirmedRemoteFailure(
                "n8n has not confirmed revoking earlier sign-ins. Try disconnecting again later.",
              );
            }
            // Queue before removal so a failed or interrupted revoke never loses the grant.
            await this.#writePendingRevocations([
              ...pending,
              { clientId: credential.clientId, refreshToken: credential.refreshToken },
            ]);
          }
        }
        await this.#secrets.remove(N8N_SECRET_SUFFIX);
        this.#accessToken = null;
        this.#credentialRevision += 1;
        this.#uncertainCredentialState = false;
        // Local reset is already durable. Network cleanup is bounded and best effort; an
        // outage or cancellation cannot turn it into a faulted connection again.
        let discovery: OAuthDiscovery;
        try {
          discovery = await this.#discover(
            AbortSignal.any([
              commitSignal,
              AbortSignal.timeout(Math.min(REVOCATION_RETRY_BUDGET_MS, this.#requestTimeoutMs)),
            ]),
          );
        } catch {
          return;
        }
        if (!commitSignal.aborted) {
          try {
            await this.#retryPendingRevocations(discovery, commitSignal);
          } catch {
            // The local reset is complete and unconfirmed grants are already queued.
            // Cleanup storage failures must not fault a disconnected provider.
          }
        }
      } catch (error) {
        if (admitted) {
          this.#uncertainCredentialState = true;
          throw new ExternalCommitOutcomeUnknownError(
            "The n8n disconnect may have completed. Verify the connection state before retrying.",
          );
        }
        throw error;
      } finally {
        this.#disconnecting = false;
      }
    });
  }

  async invoke(
    toolName: string,
    input: JsonObject,
    context?: IntegrationInvocationContext,
  ): Promise<JsonValue> {
    const reviewed = REVIEWED_TOOLS.find((tool) => tool.name === toolName);
    if (!reviewed) throw new IntegrationProviderPublicError("Unknown n8n tool.");
    if (!reviewed.readOnly && context?.writeApproved !== true) {
      throw new Error("n8n writes require explicit Harness approval.");
    }
    const decoded = await Schema.decodeUnknownPromise(reviewed.input)(input, {
      errors: "all",
      onExcessProperty: "error",
    });
    assertJsonBounds(decoded);
    const generation = this.#generation;
    const access = this.#accessToken;
    if (
      !access ||
      access.expiresAt - ACCESS_TOKEN_SKEW_MS <= Date.now() ||
      !this.#sessionVerified ||
      this.#closed ||
      this.#disconnecting ||
      this.#uncertainCredentialState
    ) {
      throw new IntegrationProviderPublicError(
        "n8n access is not prepared. Reconnect if this continues.",
      );
    }
    const assertAvailable = () => {
      if (!this.#availableTools.has(reviewed.upstreamName)) {
        throw new IntegrationProviderPublicError(
          "This n8n tool is not available under the connected user's grant or instance configuration.",
        );
      }
    };
    assertAvailable();
    let admitted = false;
    const signal = reviewed.readOnly
      ? context?.signal
      : typeof context?.beginCommit === "function"
        ? await context.beginCommit().then((commitSignal) => {
            admitted = true;
            return commitSignal;
          })
        : (() => {
            throw new Error("n8n writes require Harness commit admission.");
          })();
    if (!signal) throw new Error("n8n invocation requires a cancellation signal.");
    const timeout =
      reviewed.upstreamName === "test_workflow" ? TEST_REQUEST_TIMEOUT_MS : this.#requestTimeoutMs;
    const call = async () => {
      // Re-checked on every attempt: a recovered session re-verifies the catalog and may have
      // paused or dropped this tool.
      assertAvailable();
      const result = asRecord(
        await this.#mcpRpc(
          access,
          "tools/call",
          { name: reviewed.upstreamName, arguments: decoded as Record<string, unknown> },
          signal,
          MCP_TOOL_RESPONSE_BYTES,
          timeout,
        ),
        "n8n MCP tool result",
      );
      if (result.resultType !== "complete") {
        throw new ConfirmedRemoteFailure(
          "n8n requested an interactive MCP response that TritonAI Harness does not support.",
        );
      }
      if (result.isError === true) {
        throw new ConfirmedRemoteFailure("n8n reported that the tool operation failed.");
      }
      const structured = result.structuredContent;
      if (structured && typeof structured === "object" && !Array.isArray(structured)) {
        const record = structured as Record<string, unknown>;
        if (record.status === "error" || typeof record.error === "string") {
          throw new ConfirmedRemoteFailure("n8n reported that the tool operation failed.");
        }
      }
      if (generation !== this.#generation || this.#closed || this.#disconnecting) {
        throw new Error("n8n access changed during the tool call.");
      }
      return result as JsonValue;
    };
    try {
      return await call();
    } catch (error) {
      if (error instanceof SessionInvalidError && reviewed.upstreamReadOnly) {
        await this.#initializeSession(access, signal);
        return call();
      }
      if (!reviewed.upstreamReadOnly && admitted) {
        this.#uncertainCredentialState = true;
        throw new ExternalCommitOutcomeUnknownError(
          "The n8n operation may have completed. Verify its result before retrying.",
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#connectAttempt += 1;
    for (const controller of this.#requestControllers) controller.abort();
    await this.#clearPendingFlows();
    this.#accessToken = null;
    this.#sessionId = null;
    this.#sessionVerified = false;
    this.#availableTools = new Set();
    this.#pausedTools = [];
  }
}
