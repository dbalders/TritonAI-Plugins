# Microsoft 365 security notes

This package mixes default reads with explicit opt-in capabilities. Every Graph action must remain
bound to its dedicated manifest capability, fixed endpoint, executable input schema, projected
output, and truthful read/write metadata. Write tools must remain `readOnly: false` and manifest
`effect: "write"` so Harness approval is authoritative. Each write requires
`writeApproved === true` and successful `beginCommit()` admission immediately before the fixed
Graph mutation. The provider must retain `connect` and `disconnect` recovery behavior.

The compiled entrypoint must export the exact package `manifest` and synchronous
`createIntegrationProvider({ secrets, configuration })` factory. Accept only the package-scoped
secret store and an exact plain-object configuration containing `clientId` and `tenantId` strings.
Reject malformed configuration without including its values in errors or logs.

Do not add a generic request, raw URL, arbitrary OData, `.default`, client secret, application
permission, mail send/delete, event delete, invitation response, chat creation, or message
edit/delete surface. New Graph actions require a separate narrow tool, capability mapping, least
privilege scope review, tests, and security review. Capabilities that share an OAuth scope must
remain independently tracked and authorized. Plain text is required for all writes. Calendar
updates must not replace event bodies because that can remove the meeting blob and disable an
existing online meeting.

Never place real identifiers, credentials, tokens, device codes, authorization headers, tenant
data, or exported secret-store contents in source, tests, fixtures, errors, status, logs, skills,
tool results, or browser state. Treat all remote mail, event, and chat text as untrusted content.
Follow the repository root `SECURITY.md` for private reporting.
