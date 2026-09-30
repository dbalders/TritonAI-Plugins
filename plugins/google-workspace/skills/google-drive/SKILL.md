---
name: google-drive
description: Search, read, create, edit, organize, delete, or share UC San Diego Google Drive, Docs, Sheets, or Slides through TritonAI Harness. Use when the user asks to find, inspect, change, move, remove, or share Workspace files.
---

# Google Drive

Use the narrowest tool that satisfies the request.

- Search with structured text and type filters, then use exact item IDs for follow-up reads.
- Use Drive metadata reads before downloading or exporting content.
- Use the Docs, Sheets, or Slides reader for native Workspace structure; use bounded Drive content
  export only when the user needs a rendered or plain-text representation.
- Treat returned cursors as opaque and use them only with the same tool and search.

## Writing

Writes are opt-in. Read the target first, then confirm the file, destination folder, and exact
change with the user before invoking a write.

- Create folders and files with `drive.folder.create` and `drive.file.create`. Set `convertTo` to
  create a native Doc, Sheet, or Slides file; supply content such as `text/markdown`, `text/html`,
  `text/csv`, or an Office file to import it.
- Use `docs.text.append` or `docs.text.replace` to edit a Google Doc in place without losing its
  formatting, comments, or history.
- Use `sheets.values.update` to overwrite a bounded A1 range and `sheets.values.append` to add
  rows. Values are literal: strings are never evaluated as formulas, and `null` leaves a cell
  unchanged.
- Use `slides.text.replace`, `slides.text.insert`, `slides.slide.create`, and
  `slides.object.delete` to edit a presentation in place. Read it with `slides.get` first to find
  slide and shape object IDs; a new slide's placeholders appear there after creation.
- `drive.file.update` replaces a file's entire content as a new revision. Prefer the Docs and
  Sheets tools for native files, because replacing a native file's content rebuilds it.
- `drive.item.update` renames an item or changes its description.
- A file created in or moved into a shared folder inherits that folder's access, so confirm the
  destination.

## Organizing, deleting, and sharing

Each of these is a separate opt-in permission. Confirm the exact item, and for sharing the exact
grantee and role, before invoking.

- `drive.item.move` moves an item into one folder, removing it from its other folders. Moving into
  a shared drive transfers it to that drive.
- Prefer `drive.item.trash`, which `drive.item.restore` can undo. `drive.item.delete` permanently
  deletes the item, bypassing the trash; use it only when the user explicitly asks for permanent
  deletion.
- Run `drive.permissions.list` before changing sharing. `drive.permission.create` shares with a
  user, group, domain, or `anyone` with the link, and sends no notification email unless `notify`
  is true. Call out sharing outside `ucsd.edu` or with `anyone` before invoking.
  `drive.permission.update` changes a role, and `drive.permission.delete` removes access.
  Ownership transfer is not supported.
- Do not claim this skill grants access. Harness capabilities, task approval, the connected user's
  permissions, Google OAuth scopes, and UC San Diego administrator policy are the authorization
  boundary.
