# paperclip-plugin-apprise

Notifications for [Paperclip](https://github.com/paperclipai/paperclip) events to 100+ services
(Telegram, e-mail, Slack, Discord, ntfy, Matrix…) through an
[apprise-api](https://github.com/caronc/apprise-api) server.

## Install

```bash
paperclipai plugin install paperclip-plugin-apprise
```

You also need a running apprise-api (for example the `caronc/apprise` image; see
[`examples/notify/docker-compose.yml`](../../examples/notify/docker-compose.yml)).

## Two modes

| | `stateful` (default) | `stateless` |
| --- | --- | --- |
| Where destinations live | In apprise-api, saved under a configuration key | In Paperclip, as company secrets (Apprise URLs contain tokens) |
| Routing by severity | By tag: `tagsBySeverity` picks the Apprise tags | Per destination: each URL has a `minSeverity` |
| Priority and click link | Fixed in the saved URLs; the link is appended to the body | ntfy destinations get `priority`, `tags` and `click` added to the URL; others get the link in the body |

Stateful keeps credentials out of Paperclip. Stateless needs apprise-api's stateless mode enabled.

## Configure

Per company: **Settings → Plugins → Apprise**. A company without saved configuration gets nothing.

| Field | Default | Notes |
| --- | --- | --- |
| `apiUrl` | — | Required, e.g. `http://apprise:8000`. |
| `mode` | `stateful` | `stateful` or `stateless`. |
| `configKey` | — | Stateful: the apprise-api configuration key, as a secret. |
| `tagsBySeverity` | `info`, `info`, `alert`, `urgent,alert` | Stateful: tags for low, normal, high, urgent (comma = any of, space = all of). |
| `destinations` | none | Stateless: `[{ url: secret, minSeverity }]`, at least one. |
| `format` | `text` | `text` or `markdown`. |
| `auth` | `none` | `basic` for an apprise-api with `APPRISE_AUTH_REQUIRED`. |
| `extraHeaders` | none | Secret headers, e.g. `X-Apprise-Config-ID` for a configuration user, or Cloudflare Access. |

The shared fields — `paperclipBaseUrl`, `events`, `minSeverity`, `filters`, `quietHours`,
`rateLimit`, `retry`, `network.allowPrivateNetwork` — work as in
[paperclip-plugin-ntfy](../plugin-ntfy/README.md#configure), and so does the event list.

Test from the company settings page **Apprise** (`/<prefix>/company/settings/apprise`) with
**Send test notification** (in stateless mode it reaches every destination).

## Delivery results

| apprise-api answer | Plugin behaviour |
| --- | --- |
| 200 | Delivered. |
| 204 | No saved configuration for the key (stateful) or no valid URL (stateless): not retried. |
| 424 | A destination failed or no tag matched: not retried, since that would repeat it on the destinations that did receive it. |
| 429, 5xx, network error | Retried with back-off. |
| 400, 401, 403, 404 | Not retried; the status page says what to check. |

In stateless mode, ntfy destinations and the others go in separate requests. If one of them is
delivered and the other fails, the failure is not retried, to avoid duplicates.

Errors never include apprise-api's response body, which can echo destination URLs with
credentials.

## Good to know

- Tags must start with a letter or digit and may use letters, digits, `_` and `-` (apprise-api
  rejects anything else); they are lower-cased.
- For an apprise-api on your LAN, turn on `network.allowPrivateNetwork` (the host blocks private
  addresses by default). Only do this for a server you trust.
- Events emitted while the plugin's worker is not running are lost; queued retries and digests
  survive restarts.

## License

[MIT](../../LICENSE)
