# Security

Version 2.0.0 uses broker SDK2. Its worker has no credential store, raw API-key submission,
OAuth handler, connection lifecycle, network dependency or commit-authority callback. It requests
one known operation with the exact original tool input. The host validates schema and approved
payload, selects the connection credential, enforces the independently pinned recipe and transport,
observes preconditions and admits writes through the F05 journal. Worker output cannot settle an
unknown external commit.

The canonical recipe is a proposed dependency, not permission to execute it. A host must separately
approve its digest and reject changed destinations, queries, payloads, capabilities or generations.
Fixed HTTPS and schema checks are insufficient without host DNS/socket/redirect/response policy.
The host owns API-key validation/storage, lifecycle authorization and conservative legacy-grant
migration. No automatic credential migration is implemented by this package.

Input and output bounds, safe form-key normalization, explicit write/null confirmations and exact
existing schemas remain. The host must independently enforce these constraints, version checks
and draft-action/document binding; worker checks are not authoritative. Kuali's version check is
not atomic. Creates, edits and submission may be irreversible and are never automatically retried.

Artifact import/ambient API checks are release hygiene, not an OS sandbox. Package tests use
synthetic host fixtures and make no native, live-provider, consent or release claim. Never enable
this worker without the host's verified native isolation and SDK2 support. Use a least-privilege
Kuali account and campus policy for restricted data. Do not put credentials or records in reports.
