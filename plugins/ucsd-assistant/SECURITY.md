# UCSD Assistant data boundary

This package reads public sources. It has no OAuth/API-key entry, does not read the
plugin secret store, and never sends browser cookies or user credentials. Public
queries and page URLs go to the selected campus source or search provider; returned
content is available to the active Harness model and conversation.

Public support search uses the fixed anonymous portal search endpoint. Its POST
performs a query, not a record change. It refuses redirects, bounds response size
and time, and constructs original URLs from validated article numbers. Search
snippets do not establish original article access or freshness.

The page reader allows HTTPS on port 443 for official UCSD domains and reviewed
external sources. It validates every redirect and DNS answer and pins an approved
public address for the HTTPS connection. The external UCSD policy directory is
limited to its `/ucsd/public/` path. It rejects private/reserved addresses, login
URLs, credential-bearing query parameters, compressed or oversized responses and
binary content. It identifies loading shells and refers them to the browser.
Downloads, text and links have independent bounds. No page script
is executed, no forms are submitted, and no persistent content index is created.

Page text, search snippets and remote tool descriptions are untrusted evidence.
The skills require original-source citations, source/time distinctions, and explicit
handling of access errors, missing results and truncation. A published source
category does not grant access to private records at the same organization.

Onyx is inspected only to identify existing source/tool assignments; its session
and saved credentials are not copied. Authenticated campus MCPs remain outside the
login-free dispatch surface. Maps and busyness use separately verified anonymous
REST services at fixed endpoints; no caller-supplied destination or authorization
header is accepted. Map queries whitelist fields and validate coordinates; service
responses, route directions and names remain untrusted evidence. Adapters bound
bytes, time, arrays and text, and refuse redirects. Busyness measurement time is
unknown; modeled routes do not establish current closures or field accessibility.
A user's saved plugin disable choice must survive host reconciliation.
