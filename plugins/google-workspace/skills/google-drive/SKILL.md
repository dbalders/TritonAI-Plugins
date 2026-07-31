---
name: google-drive
description: Search or read UC San Diego Google Drive, Docs, Sheets, or Slides through TritonAI Harness. Use when the user asks to find or inspect Workspace files without changing them.
---

# Google Drive

Use the narrowest read tool that satisfies the request.

- Search with structured text and type filters, then use exact item IDs for follow-up reads.
- Use Drive metadata reads before downloading or exporting content.
- Use the Docs, Sheets, or Slides reader for native Workspace structure; use bounded Drive content
  export only when the user needs a rendered or plain-text representation.
- Treat returned cursors as opaque and use them only with the same tool and search.
- Do not claim this skill grants access. Harness capabilities, the connected user's permissions,
  Google OAuth scopes, and UC San Diego administrator policy are the authorization boundary.
- This plugin cannot create, edit, move, share, change permissions on, or delete Drive content.
