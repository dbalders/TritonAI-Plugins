# Tableau

> [!WARNING]
> **Temporarily unavailable (paused 2026-10-09).** Tableau is no longer offered in TritonAI Harness.
> It has been removed from the Installer's managed plugin catalog while campus feedback is reviewed,
> and should stay out for about a month. The source, tests, and SDK artifact are kept here unchanged so
> it can return. To bring it back, add it to the managed plugin catalog again.

`@tritonai/plugin-tableau` connects Harness directly to UCSD's campus business Tableau Server.
It uses browser OAuth with PKCE and fourteen reviewed REST tools with opt-in writes. No separate MCP service,
PAT, shared account, or Tableau-specific Harness runtime is required.

## Connection

Enable Tableau in Harness Plugins and select Connect. Complete campus sign-in in a browser on
the computer running the Harness server. The loopback listener binds only to `127.0.0.1`, uses an
ephemeral port and `/Callback`, and expires after ten minutes. Remote/mobile clients must complete
this step on the host computer. The browser returns to a plain completion page; Harness polls to
exchange the code and verify the user and configured site before storing the credential.

UCSD's tested OAuth response contains an access token and an empty refresh token. This is valid
for this provider. Its observed lifetime was four hours; that is not a guarantee of session length
or a requirement to type a password every four hours. A later connection can reuse campus SSO.
The provider refreshes expired access during host lifecycle preparation only when a refresh token
exists. Otherwise it reports that reconnect is needed. It never opens browsers in the background,
asks for passwords in chat, or promises uninterrupted unattended operation.

## Configuration

The configuration is optional fields only:

```json
{ "serverUrl": "https://tableau.ucsd.edu", "siteContentUrl": "" }
```

The origin is fixed. An empty site content URL means Default. Other site content URLs must be
explicitly configured and must match the authenticated session. Tokens live only in the host's
package-scoped secret store. The API version is pinned to 3.27, as verified against UCSD 2025.3.8.

## Tools and bounds

- `tableau.projects.list`: accessible projects.
- `tableau.workbooks.list` / `tableau.workbooks.get`: workbook discovery and metadata.
- `tableau.views.list` / `tableau.views.get`: view discovery, metadata, and source links.
- `tableau.views.data`: filtered CSV, capped at 512 KiB, with explicit coverage and retrieval time.

List requests default to 25 results, at most 100, with bounded page numbers and exact-name filters.
Other JSON API results are capped at 1 MiB and requests time out after 20 seconds. CSV/file downloads allow up to 90 seconds. Data errors are
returned as structured tool results, so a permission rejection does not fault the plugin.

A dashboard CSV on API 3.27 contains only the first worksheet. The result and skill explicitly
identify that limit. Individual accessible worksheets must be requested separately. The plugin does not query arbitrary databases or expose account/permission administration.

## Updates and publishing

Enable **Update and publish content** in Tableau's plugin access settings to expose the apply tool.
Read access alone can prepare a preview but cannot submit a change. UCSD still checks the connected
user's permissions for each operation; enabling writes does not grant new Tableau permissions.

Additional tools:

- `tableau.datasources.list` / `tableau.datasources.get`: published data source discovery and metadata.
- `tableau.datasources.connections`: bounded connection IDs/types without credentials.
- `tableau.workbooks.download` / `tableau.datasources.download`: files without extracts, returned as
  base64, capped at 350,000 bytes so the result fits the host's tool-output limit.
- `tableau.jobs.get`: queued/running/completed state and a separate success result.
- `tableau.changes.prepare`: inspect a proposed change without changing Tableau.
- `tableau.changes.apply`: apply one exact preview under the host's write admission controls.

Prepare supports workbook name/description/tab visibility/project, data source name/certification/
project, tags on workbooks/data sources/views, workbook and data source extract refreshes, publishing
new or replacement workbooks/data sources, and live-to-Hyper insert/update/upsert/replace/delete batches.
Refresh requests use API 3.27's full refresh operation. Queued jobs must be polled before claiming success.

Publishing takes a prepared `.twb`/`.twbx` or `.tds`/`.tdsx`/`.hyper` file as base64, at most 2 MiB.
To create, provide name and project ID; overwrite requires the existing resource UUID and derives its
current name/project. Preserve the downloaded original and validate edited files in Tableau first.
The preview shows the operation, target, file hash and size; it does not render charts or validate
workbook semantics. Dashboard/layout/calculation changes require editing a workbook file or Tableau's
authoring UI. Local dependencies must already be packaged. The plugin never reads local file paths,
extracts archives, or supplies connection passwords.

Hyper updates require a prepared `.hyper` payload (for example, created with Tableau's Hyper API)
and an action batch. The plugin does not create Hyper files. Only published live-to-Hyper connections
support these row changes; ordinary database connections and refresh-backed extracts do not. A Hyper
connection type is a prerequisite, not proof of live-to-Hyper eligibility: Tableau makes the final
check. Source/target schemas must match the requested action. Delete/update/upsert require bounded
conditions; replace affects the whole target table. The preview cannot predict affected row counts.

Previews expire after ten minutes, are bound to the account/site, hold at most four payloads, and are
cleared on disconnect/restart. Apply rechecks target metadata, then consumes the preview before dispatch.
This preflight is not an atomic Tableau lock. Review before applying, especially overwrites and project
moves that can change inherited access. `outcome_unknown` means a request may have succeeded: inspect
Tableau before preparing another attempt. `upload_incomplete` means no Hyper update request was sent,
although temporary upload data may remain. Neither result permits an automatic retry.

Official contracts: [content publishing](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_concepts_publish.htm),
[workbook operations](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_workbooks_and_views.htm),
[data source operations](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_data_sources.htm),
and [Hyper action batches](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_how_to_update_data_to_hyper.htm).

## Distribution and verification

Build the sealed artifact with `pnpm artifacts:sdk`; verify with `pnpm readiness` and the repository's
exact clean Harness contract check. Include `tableau` in the Installer-managed composition with
configuration keyed by `tableau`. Source and sealed artifact checks do not publish a plugin update.

Run `pnpm --filter @tritonai/plugin-tableau test` for callback, token, permission, cancellation,
response-bound, and read-result coverage. Live proof must use the packaged provider and host
connection flow. Unit tests do not prove campus-wide permissions or Windows/remote sign-in.
