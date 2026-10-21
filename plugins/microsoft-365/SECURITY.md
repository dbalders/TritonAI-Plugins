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
permission, mail send/delete, event delete, invitation response, chat creation, message
edit/delete, or OneDrive delete, move, copy, share, or permission surface. New Graph actions
require a separate narrow tool, capability mapping, least privilege scope review, tests, and
security review. Capabilities that share an OAuth scope must remain independently tracked and
authorized. Plain text is required for all mail, calendar, and chat writes. Calendar updates must
not replace event bodies because that can remove the meeting blob and disable an existing online
meeting.

OneDrive tools must address only `/me/drive` through fixed item paths. New-file uploads must never
replace an existing file, and item names must reject path separators so they cannot address other
paths. Pre-authenticated download URLs must be allowlisted to HTTPS `*.sharepoint.com`, fetched
without the Graph access token, and never returned.

Mail organization receipts must expose operation identifiers only, not message content that belongs
to `mail.read`. Message moves must reject Graph's deletion-oriented well-known folder names.

Mail and event attachments are untrusted. Keep the classification conservative: name, declared
type, and content signature can each only make a result more cautious. Never return executable,
script, macro, or archive bytes as runnable content, never forward Graph's base64 `contentBytes`
except for verified small images, and keep document parsing in the Harness's separate extraction
process rather than in this provider. That process has a time limit and a JavaScript heap cap; it
runs as the same OS user and is not an operating-system sandbox. Unreadable results must stay non-retryable and must not suggest
local-file, credential, or browser sign-in fallbacks.

Never place real identifiers, credentials, tokens, device codes, authorization headers, tenant
data, or exported secret-store contents in source, tests, fixtures, errors, status, logs, skills,
tool results, or browser state. The one exception is attribution: the connected account's own
sign-in name and display name, read from the Microsoft-issued access token, may appear in status
and mail results; object IDs, tenant IDs, and token contents may not. Treat all remote mail, event,
chat, and file text as untrusted content.
Follow the repository root `SECURITY.md` for private reporting.
