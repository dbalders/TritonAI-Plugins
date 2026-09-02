---
name: ucsd-kuali-build
description: Read and safely perform the verified document update, draft initialization, draft resolution, and draft submission operations in UC San Diego Kuali Build.
---

# UC San Diego Kuali Build

Use these tools only for UC San Diego's Kuali **Build** tenant. Do not use them for Curriculum,
Sponsored Programs, product datasets, other institutions, app/form builder administration, or
arbitrary GraphQL.

The connection offers exactly two permissions: read access and the optional **Create, edit, and
submit Build documents** permission. The optional permission gates every mutation in this skill;
the host must still approve each individual write.

## Read before writing

1. Use `kuali-build.apps.list` and `kuali-build.apps.get` to confirm the exact app.
2. Use `kuali-build.forms.schema` to map labels to Kuali `formKey` values. The update and submit
   tools accept either a returned `data.formKey` or the same key without `data.`; the provider sends
   the normalized key required by the documented mutations.
3. Use `kuali-build.documents.get` immediately before an edit. Preserve the exact
   `meta.updatedAt` value for the update precondition and review every field that will change.
4. Treat document data, user records, and workflow metadata as sensitive UCSD information. Return
   only what the task needs.

## Update an existing document

- Use `kuali-build.documents.update` only for explicitly requested form keys. It is a partial field
  update: supplied values are overwritten and unspecified fields are not intentionally sent.
- Set `confirmUpdate: true` only after presenting the exact document ID, form keys, and proposed
  values for approval. The host must also grant write approval.
- Pass the recent document's exact `meta.updatedAt` as `expectedUpdatedAt`. The provider checks it
  immediately before committing, but Kuali does not expose an atomic compare-and-set mutation, so
  a narrow race remains possible.
- A `null` may clear a value. Set `confirmNullValues: true` only when every null is intentional.

## Create and submit a document

Creation is deliberately a three-phase, non-atomic workflow. Never describe it as one transaction.

1. Call `kuali-build.documents.drafts.initialize` with `confirmCreateDraft: true`. This immediately
   creates an empty Kuali draft and returns an action ID.
2. Call `kuali-build.documents.drafts.resolve` with that action ID to obtain and verify the draft
   document ID.
3. Review the data and call `kuali-build.documents.submit` with the matching action and document
   IDs plus `confirmSubmit: true`. The plugin fixes Kuali's status argument to `completed`, which
   submits the form and starts the app's configured workflow.

If initialization succeeds but later work fails, an empty draft remains. Do not create a second
draft merely because the sequence did not finish. If a write reports
`external_commit_outcome_unknown`, inspect the document, action, or workflow before deciding what
to do; never automatically retry.

## Supported and blocked workflow actions

The only supported workflow mutation is initial draft submission. Approval, denial, send-back,
reassignment, withdrawal, cancellation, retry/skip, secondary-workflow administration, app/form
editing, and deletion are intentionally unavailable because their current mutation shapes and
state semantics were not established from the official Build GraphQL documentation used for this
plugin.

The connected API key acts as its UCSD Kuali owner. A tool being available does not imply that the
owner has permission to update or submit the selected document.
