---
name: n8n-workflows
description: Find, inspect, build, test, execute, publish, archive, or manage n8n workflows, folders, Data Tables, and Agents through TritonAI Harness using the connected user's n8n access.
---

# n8n workflows

Use the narrowest n8n tool that completes the request. Read current workflow, project, credential,
execution, or Data Table state before changing it.

- This skill grants nothing by itself. OAuth scopes, the connected user's n8n role, project and
  resource permissions, workflow MCP availability, and Harness task approval are authoritative.
- Full plugin access never means n8n administrator access. The user can only act on resources n8n
  allows that user to see or change.
- `search_workflows` can return previews of every workflow the user can access, even when a
  workflow is not marked **Available in MCP**. Other workflow operations still enforce n8n's MCP
  exposure and permission rules.
- Treat execution as a write: production workflows may contact external systems. `test_workflow`
  pins triggers, credentialed nodes, and HTTP Request nodes, but credential-free I/O nodes can still
  execute. Confirm the intended workflow, mode, and inputs before invoking either tool.
- Before building, read the SDK reference, search nodes, fetch exact node types, validate node
  configuration, and validate the workflow. Resolve named projects, folders, and credentials by ID;
  never guess between ambiguous results.
- Confirm create, edit, publish, unpublish, archive, column deletion, table changes, and row inserts.
  Deleting a Data Table column permanently removes that column and its data.
- `create_workflow_from_code` makes the new workflow available to MCP. Publishing is a separate
  action. Report the actual project and workflow identifiers returned by n8n.
- Do not claim a workflow succeeded from an execution-start receipt. Use the returned execution ID
  and read its final status when the user needs completion proof.
- At the start of open-ended work, read `get_instance_context` and `get_user_preferences` when they
  are available, and follow the saved preferences when choosing nodes, credentials, and names.
- For Agents, read the builder reference and `get_agent` first, and pass the latest `configHash` to
  `mutate_agent`. `call_agent` runs the draft with its real tools and credentials, so treat it like
  a production execution. Confirm before publishing, unpublishing, reverting, or deleting an Agent,
  or changing its chat integrations.
- `install_community_node` installs code onto the shared n8n instance. Only offer it for a verified
  package that `search_nodes` reported as missing, and confirm with the user first.

## Editing an existing workflow

Use `update_workflow`, not a new workflow. Read `get_workflow_details` first and copy exact node
names. Each operation has a `type` and only the fields documented for that type; there is no
`updateNode` type and no `changes` field. To replace a Code node's JavaScript:

```json
{
  "workflowId": "<workflowId>",
  "versionName": "Skip rows without an email",
  "operations": [
    {
      "type": "updateNodeParameters",
      "nodeName": "Format Rows",
      "parameters": { "jsCode": "<complete new code>" }
    }
  ]
}
```

- `updateNodeParameters` merges `parameters` into the node's existing parameters. Set
  `replace: true` only when every parameter the node needs is included.
- Use `addNode`, `removeNode`, `renameNode`, `addConnection`, and `removeConnection` for structure
  changes; connection operations use `source` and `target` node names.
- Keep each call to one logical change so a failure is easy to read. If one operation fails,
  nothing in that call is saved, except invalid node-group operations, which are skipped and
  reported in `skippedOperations`. n8n also removes an existing group that an edit leaves invalid
  and reports it in `removedGroups`. Check both before you report the edit as complete.
- If the call is rejected as invalid input, nothing was sent to n8n: read the error, fix the
  input, and retry. Do not report the tool as unavailable because of an input error.
- If the result says the operation may have completed, do not resend it. Read
  `get_workflow_details` first, because repeating structural operations can duplicate changes.
- After saving, read `get_workflow_details` again to confirm the change before you report it.
