# Security notes

- Authentication uses a user-scoped Jira Data Center personal access token sent only as a Bearer
  credential to the fixed `https://its-pro.ucsd.edu` origin.
- The token is validated before storage and is retained only in the Harness package-scoped secret
  store under this plugin's namespace.
- Configuration rejects alternate origins, paths, ports, credentials, query strings, and URL
  fragments. HTTP redirects are rejected.
- The provider exposes fixed, read-only REST operations. It does not accept arbitrary URLs,
  endpoints, HTTP methods, response expansions, field lists, or attachment locations.
- Inputs, response byte size, JSON shape, pagination, collection sizes, and projected strings are
  bounded. Unsafe object members and malformed JSON are rejected.
- Jira permissions remain authoritative. A token cannot read projects or issues that its Jira user
  cannot access.
- Errors, status results, and tool responses never return the personal access token or raw
  authorization headers.

Never place a live UCSD Jira token, issue content, project data, or sanitized-but-reversible
credential material in source, tests, logs, screenshots, issues, or pull requests.
