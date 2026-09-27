# @paperclip-plugins/notify-core

Internal notification pipeline shared by the [Paperclip](https://github.com/paperclipai/paperclip) notifier plugins
(`paperclip-plugin-ntfy`, `paperclip-plugin-apprise`).

It is private and never published: each plugin lists it as a `devDependency` (`workspace:*`) and esbuild bundles it
into the plugin's `worker.js`, so published plugins do not depend on it.

It is a library, not a plugin: importing it registers nothing. A plugin calls it from its `setup`.
See the [design spec](../../docs/specs/2026-09-27-notify-plugins-design.md).

## License

[MIT](../../LICENSE)
