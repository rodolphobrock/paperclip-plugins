# @paperclip-plugins/notify-core

The notification pipeline shared by [paperclip-plugin-ntfy](../plugin-ntfy/README.md) and
[paperclip-plugin-apprise](../plugin-apprise/README.md). Private: it is never published. Each
plugin lists it as a `devDependency` (`workspace:*`) and esbuild bundles it into the plugin's
`worker.js` (the settings page comes from `@paperclip-plugins/notify-core/ui`).

It is a library, not a plugin: importing it registers nothing. A plugin supplies a sender and a
config parser and calls `createNotifier(...).setup(ctx)` from its own `setup`.

```
event ─► config ─► facts (approvals/agents/issues) ─► draft (pure mapper) ─► policy
      ─► dedupe (eventId + semantic key) ─► deep link ─► delivery
         delivery: quiet hours ─► rate limit ─► send ─► retry queue / digest ─► drain job
```

| Module | Responsibility |
| --- | --- |
| `catalog.ts`, `mappers.ts` | Subscribed events, default rules, event → notification text (pure) |
| `enrich.ts`, `policy.ts` | Host lookups with graceful degradation; toggles, severities, filters |
| `dedupe.ts`, `links.ts` | One notification per fact; Paperclip deep links |
| `delivery.ts`, `queues.ts`, `quiet-hours.ts`, `rate-limit.ts`, `digest.ts` | Quiet hours, token bucket, digest, retry, the `delivery-drain` job |
| `notifier.ts`, `status.ts` | Wiring to the plugin context, `send-test` action, `status` data, health |
| `config.ts`, `fields.ts` | Shared config fields, JSON Schema pieces, secret and header parsing |
| `http-result.ts`, `redact.ts` | HTTP result classification; removing credentials from text |

Design: [spec](../../docs/specs/2026-09-27-notify-plugins-design.md) and
[plan](../../docs/superpowers/plans/2026-09-27-notify-plugins.md) (in Portuguese).

## License

[MIT](../../LICENSE)
