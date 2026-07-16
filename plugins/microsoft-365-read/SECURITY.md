# Microsoft 365 Read security notes

This package is intentionally read-only. Do not add send, create, update, delete, generic request,
raw URL, arbitrary OData, write scope, `.default`, client-secret, or application-permission support.
A future write-capable package must use a separate plugin ID, Entra application, credential
namespace, manifest, tools, skills, and security review.

Never place real identifiers, credentials, tokens, device codes, authorization headers, tenant data,
or exported secret-store contents in source, tests, fixtures, errors, status, logs, skills, tool
results, or browser state. Follow the repository root `SECURITY.md` for private reporting.
