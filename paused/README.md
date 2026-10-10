# Paused plugins

Plugins here are kept for later restoration but are not part of any release. Nothing in this
directory is a workspace package, is built, sealed, tested, or appears in a tagged Plugins release,
so Harness and Installer cannot ship it.

| Plugin  | Paused     | Last version | Reason                                          |
| ------- | ---------- | ------------ | ----------------------------------------------- |
| Tableau | 2026-10-09 | 1.1.0        | Campus pushback; expected back in about a month |

## Restoring a plugin

1. `git mv paused/plugins/<id> plugins/<id>` and `git mv paused/artifacts/<id> artifacts/<id>`.
2. Point its `.prettierignore` entry back at `plugins/<id>/` and run `pnpm install` to restore its
   lockfile importer.
3. Run `pnpm readiness`, tag a new Plugins release, then add the plugin back to the Installer
   managed plugin catalog and bump the Harness composition pin.
