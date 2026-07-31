---
name: google-calendar
description: Read, create, or narrowly edit UC San Diego Google Calendar events through TritonAI Harness. Use when the user asks about their schedule or requests an event change.
---

# Google Calendar

Read a bounded date range or one exact event before proposing a change.

- Calendar ranges must be positive and no longer than 31 days.
- Creating or editing an event is opt-in. Confirm the calendar, title, start, end, location, and
  description before invoking a write.
- Writes use `sendUpdates=none` and cannot add attendees, send invitations, respond to invitations,
  provision conferencing, delete events, transfer ownership, share calendars, or change ACLs.
- Treat cursors as opaque and reuse them only with the same calendar/list operation.
- This skill does not authorize access. Harness capabilities, task approval, OAuth scopes, calendar
  permissions, and UC San Diego administrator policy are the actual boundary.
