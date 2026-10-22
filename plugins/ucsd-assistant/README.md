# UCSD Assistant

Find campus information directly from public UC San Diego sources. The plugin bundles
the 71 source categories published for the UC San Diego Assistant, search skills,
source-scoped web queries, anonymous public support-article search, and a bounded original-page reader. It has no Onyx
runtime connection, document corpus, embedding pipeline, persistent index or sign-in.

`ucsd.search_public_kb` searches public IT and Services & Support articles and returns
bounded snippets and original article URLs. Open the originals before citing them.
`ucsd.list_sources` finds source sites and their stable IDs. `ucsd.plan_search`
returns focused queries and public search URLs; the agent runs them with its available
web search or browser. It returns a plan, not search results. `ucsd.read_page`
reads original public HTML/text pages. Dynamic pages and PDFs may require the
browser or provider's page reader. The skills explain that distinction and require
citations to the original supporting sources.

Source mappings come from the public guide and current official sites. They do
not establish exact membership, exclusions or freshness of an Onyx deployment's
index, or guarantee that public web search finds every indexed document.

## Campus services

`ucsd.list_services` describes available routes and reports authorization or service
limitations. The Maps and Busyness MCPs configured in Onyx use authenticated campus
gateway connections. Onyx's Public setting controls availability to Onyx users; it
does not make the gateway anonymous. No saved Onyx token is used by this plugin.
Only independently verified anonymous services are included as login-free tools.

Six map tools query the official public GIS services: building and place search,
POI categories and nearby places, geodesic distance, and modeled walking/ADA routes.
`ucsd.get_campus_busyness` queries the Waitz feed used by UCSD Library, including
floor detail and open/unavailable flags. The feed does not expose a measurement
timestamp. Routing is modeled against the source network, not live path closures.
Live anonymous parking availability remains unverified; published parking surveys
are historical. These direct REST adapters do not reproduce unverified gateway
MCP schemas or use gateway credentials.

## Harness setup

Include the sealed `ucsd-assistant` artifact in the reviewed Harness composition
with empty configuration `{}`. Its public read capability requires no connection
flow or secret. The matching Harness change enables this bundled plugin on first
discovery while retaining a user's saved disable choice. Ordinary package inclusion
alone does not prove that behavior on an older host.

## Development

Run `pnpm --filter @tritonai/plugin-ucsd-assistant build`, focused tests, and repository
`pnpm readiness`. The build generates the manifest and
self-contained Node 24 bundle with its bundled dependency notices; `pnpm artifacts:sdk` seals the distributable artifact.
This source package does not publish or deploy a campus service.
