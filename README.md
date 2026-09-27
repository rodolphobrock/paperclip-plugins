# paperclip-plugins

Community plugins for [Paperclip](https://github.com/paperclipai/paperclip).

> Work in progress. Nothing is published to npm yet.

## Plugins

| Package | Status | Description |
| --- | --- | --- |
| `paperclip-plugin-ntfy` | planned | Push notifications for Paperclip events via [ntfy](https://ntfy.sh). |
| `paperclip-plugin-apprise` | planned | Notifications to 100+ services via [apprise-api](https://github.com/caronc/apprise-api). |
| `@paperclip-plugins/notify-core` | planned (internal) | Shared notification pipeline bundled into the notifier plugins; not published. |

## Development

Requires Node.js 24.11+ and pnpm 9.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

On Windows, point npm scripts at Git Bash, since the ecosystem's scripts are POSIX:

```bash
npm config set script-shell "C:/Program Files/Git/bin/bash.exe"
```

Every user-facing change needs a changeset (`pnpm changeset`).

## Design

- [Notification plugins (ntfy and Apprise)](docs/specs/2026-09-27-notify-plugins-design.md) — in Portuguese.
- [Implementation plan](docs/superpowers/plans/2026-09-27-notify-plugins.md) — in Portuguese.

## License

[MIT](LICENSE)
