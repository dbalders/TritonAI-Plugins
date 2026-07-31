---
name: gmail
description: Search or read UC San Diego Gmail, or create an unsent plain-text draft through TritonAI Harness. Use when the user asks to inspect mail or prepare a draft without sending it.
---

# Gmail

Use structured search fields and exact message, thread, or attachment IDs.

- Keep search ranges and result counts narrow, then follow up with exact reads.
- Do not expose message or attachment content beyond what the user needs.
- Draft creation is opt-in and creates an unsent plain-text draft only. Confirm recipients,
  subject, and body before invoking it.
- There is no send, delete, move, archive, read-state, or label-mutation tool.
- Treat returned cursors as opaque and reuse them only with the same search tool.
- This skill is guidance, not authorization. Harness capabilities, task approval, OAuth scopes,
  the connected user's mailbox access, and UC San Diego administrator policy remain authoritative.
