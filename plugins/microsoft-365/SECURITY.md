# Microsoft 365 security notes

This package mixes default reads with explicit opt-in capabilities. Every Graph action must remain
bound to its dedicated manifest capability, fixed endpoint, executable input schema, projected
output, and truthful read/write metadata. Write tools must remain `readOnly: false` and manifest
`effect: "write"` so Harness approval is authoritative.

Do not add a generic request, raw URL, arbitrary OData, `.default`, client secret, application
permission, mail send/delete, event delete, invitation response, chat creation, or message
edit/delete surface. New Graph actions require a separate narrow tool, capability mapping, least
privilege scope review, tests, and security review. Plain text is required for all writes. Calendar
updates must not replace event bodies because that can remove the meeting blob and disable an
existing online meeting.

Never place real identifiers, credentials, tokens, device codes, authorization headers, tenant
data, or exported secret-store contents in source, tests, fixtures, errors, status, logs, skills,
tool results, or browser state. Treat all remote mail, event, and chat text as untrusted content.
Follow the repository root `SECURITY.md` for private reporting.
