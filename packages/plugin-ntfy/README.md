# paperclip-plugin-ntfy

Push notifications for [Paperclip](https://github.com/paperclipai/paperclip) events via
[ntfy](https://ntfy.sh): approvals waiting for you, failed agent runs, budget alerts and blocked
issues reach your phone, with priority, emoji tags and a link that opens the right page.

## Install

```bash
paperclipai plugin install paperclip-plugin-ntfy
```

Requires a Paperclip version with the plugin SDK (`@paperclipai/plugin-sdk` 2026.916.1 or later).

## Configure

Configuration is per company: **Settings → Plugins → ntfy**, with the company selected. A company
without saved configuration gets no notifications. Secrets (token, password, header values) are
chosen from the company's secrets; they are never stored in the plugin config.

| Field | Default | Notes |
| --- | --- | --- |
| `topic` | — | Required. On ntfy.sh the topic name works like a password; prefer an access token. |
| `serverUrl` | `https://ntfy.sh` | Your own ntfy server, if any. |
| `auth.mode` | `none` | `token` (access token, sent as `Authorization: Bearer`) or `basic` (username + password). |
| `extraHeaders` | none | Headers with secret values, e.g. `CF-Access-Client-Id` and `CF-Access-Client-Secret` for ntfy behind Cloudflare Access. |
| `topicsBySeverity` | none | Send some severities to another topic, e.g. `urgent` to a pager topic. |
| `paperclipBaseUrl` | — | Public URL of your Paperclip, needed for the click links. |
| `markdown`, `iconUrl` | off, none | Markdown bodies; notification icon. |
| `events` | see below | Turn events on or off and change their severity. |
| `minSeverity` | `low` | Drop anything below. |
| `filters.agentIds`, `filters.projectIds` | all | Only these agents / projects. Events without an agent or project (e.g. a company budget) still pass. |
| `quietHours` | off | `start`, `end` (`HH:MM`), IANA `timezone`, `allowUrgent`. Held notifications arrive as one digest when the window ends. |
| `rateLimit` | 10/min, 5 min | Above the limit, notifications are grouped into a digest. |
| `retry` | 5 attempts, 60 min | Retries on 429/5xx/network errors with 30 s, 1 min, 2 min… back-off. |
| `network.allowPrivateNetwork` | off | See [Private networks](#private-networks). |

Then open the company settings page **ntfy** (`/<prefix>/company/settings/ntfy`) and press
**Send test notification**: it uses the company's secrets, which the host's generic "Test
configuration" button cannot.

## Events

| Event | Default | Severity → ntfy priority |
| --- | --- | --- |
| Approval requested | on | high → 4 |
| Approval decided (approved, rejected, revision requested) | on | normal → 3 |
| Agent run failed or timed out | on | high → 4 |
| Budget hard limit reached | on | urgent → 5 |
| Budget near its limit | on | high → 4 |
| Budget incident resolved | on | normal → 3 |
| Issue blocked | on | high → 4 |
| Issue done | off | normal → 3 |
| Issue created | off | low → 2 |
| Comment by someone other than the assigned agent | off | low → 2 |
| Agent run finished | off | low → 2 |

Tags carry an emoji for the outcome (ℹ️ ✅ ⚠️ 🚨) plus the event kind and agent. Each fact is
notified once, even when the host delivers an event twice
([paperclip#13732](https://github.com/paperclipai/paperclip/issues/13732)).

## Private networks

By default the plugin sends through the host's HTTP client, which blocks private and loopback
addresses (SSRF protection). For a self-hosted ntfy on your LAN, turn on
`network.allowPrivateNetwork`: the plugin then uses a direct connection with a 10 s timeout. Only do
this for a server you trust.

## Good to know

- Events emitted while the plugin's worker is not running are lost (the host does not queue plugin
  events). Retries and digests already queued survive restarts; they live in plugin state.
- The settings page shows the last delivery and the last error; `GET /api/plugins/<id>/logs` has the
  details. Logs never contain secret values.
- When the host validates a saved config it logs one Ajv "strict mode" warning per secret field.
  It is harmless.

## Development

See the [repository README](../../README.md) and the [end-to-end checklist](../../docs/e2e-checklist.md).

## License

[MIT](../../LICENSE)
