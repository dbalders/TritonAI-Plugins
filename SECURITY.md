# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability or include credentials, tokens, account
data, or exploit details in public channels. After GitHub publication, enable and use GitHub private
vulnerability reporting. Before then, report through the approved private channel provided by the
repository owner or penetration-test coordinator.

Include safe reproduction steps, the affected commit, impact, and sanitized logs. Never attach live
credentials, authorization material, secret-store files, private account data, or deployment
identifiers.

## Supported line

Security fixes target the latest immutable source ref selected by the consuming Harness build. The
Harness commit, manifest API/version, package version, and immutable file digests identify the
deployed combination; there is no independent runtime update channel.

## Plugin expectations

- Use the narrowest practical capability, tool, network, and credential surface.
- Keep meaningfully different authorization boundaries in separate plugin IDs, credential
  namespaces, manifests, and review units.
- Never place credentials, tokens, device codes, authorization headers, deployment identifiers, or
  private user data in source, tests, fixtures, logs, skills, tool results, or browser state.
- Accept only the Harness-injected package-scoped secret-store facade; do not construct or escape a
  global credential namespace.
- Keep provider status observational. Credential and other irreversible mutations must use the
  Harness lifecycle and commit-admission contract.
- Decode tool inputs through executable schemas and return bounded, explicitly projected results.
- Treat every external redirect, URL, pagination token, and server-provided continuation as
  untrusted unless the plugin contract explicitly validates and permits it.
