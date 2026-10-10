import type { UpstreamToolSnapshot } from "./remote-mcp/RemoteMcpProvider.ts";

/** A pinned upstream tool plus the review-only fields the capture keeps for maintainers. */
export interface CapturedUpstreamTool extends UpstreamToolSnapshot {
  readonly description: string | null;
  readonly outputSchema?: { readonly [key: string]: unknown };
}
