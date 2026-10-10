---
name: ucsd-jira-changes
description: Make previewed, approved changes to UC San Diego Jira issues.
---

# Changing UC San Diego Jira

Every change is two steps. A `jira.changes.prepare_*` tool checks the request against Jira's
current state and the user's permissions and returns a preview. Nothing changes in Jira until
`jira.changes.apply` runs with that preview's exact `planId`, `previewHash`, and `summary`, and the
user approves it in Harness. Previews expire after ten minutes and work once.

1. Read first. Use `jira.issues.create_metadata` before creating an issue to find the issue type ID
   and required fields, `jira.issues.edit_metadata` before editing, `jira.transitions.list` before
   a transition, `jira.users.assignable` before assigning, and `jira.issue_link_types.list` before
   linking.
2. Prepare exactly the change the user asked for. Do not add fields, comments, or watchers they did
   not request.
   For links, check that the preview sentence (for example "ITS-1 blocks ITS-2") says what the
   user meant; swap the issue keys if it does not.
3. Show the user the preview summary and the important before/after values, then apply.
4. After `applied`, read the item again if the user needs confirmation of the final state.

Handle results literally:

- `not_applied`: Jira refused and nothing changed. Explain the reason; prepare a new preview only
  after fixing it.
- `conflict`: someone changed the item after the preview. Read it again and confirm the change still
  makes sense before preparing another.
- `outcome_unknown`: the change may or may not have landed. Never apply or prepare the same change
  again blindly. Read the issue (or search for the created issue, comment, worklog, or link) first.
  A new identical comment, worklog, link, or issue is refused until you confirm the earlier one does
  not exist and pass its `operationId` as `afterUnconfirmedOperationId`.

These tools cannot delete issues or comments, change permissions, administer projects, or call
arbitrary Jira endpoints. Jira's own permissions always apply.
