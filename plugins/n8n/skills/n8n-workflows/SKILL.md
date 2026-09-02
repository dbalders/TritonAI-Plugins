---
name: n8n-workflows
description: Find, inspect, build, test, execute, publish, archive, or manage n8n workflows and Data Tables through TritonAI Harness using the connected user's n8n access.
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
