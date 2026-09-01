---
name: ucsd-kuali-build
description: Read bounded UC San Diego Kuali Build apps, forms, documents, users, and workflow metadata.
---

# UC San Diego Kuali Build

Use these tools only for UC San Diego Kuali **Build**. Do not use them for Curriculum, Sponsored
Programs, or other Kuali product datasets.

Start with `kuali-build.apps.list` to discover an app ID. Read the app or its published form schema
before interpreting document field keys. Document lists return IDs and pagination only; request one
document or its workflow metadata only when its exact ID is known. User lookup is a bounded search,
not an identity proof.

Document data can contain sensitive institutional and personal information. Request only what the
task needs and do not echo excess fields. These tools are read-only and cannot submit, approve,
send back, reassign, create, update, delete, export, or invoke arbitrary GraphQL.
