# End-to-end checklist

What is automated, and what to check by hand before a release. Acceptance criteria are those of the
[design spec](specs/2026-09-27-notify-plugins-design.md#critérios-de-aceite).

## Automated

| Where | What | Criteria |
| --- | --- | --- |
| Unit and SDK harness tests (`pnpm test`) | Mapping of every default event, dedupe with handlers registered twice (the host bug paperclip#13732 cannot be triggered on demand, so criterion 2 is covered here only), approval decisions, budget soft/hard, quiet hours and digest with a fake clock, retry and drop, no secrets in errors | 1–7, 11 |
| `Integration` workflow (`pnpm test:integration` against `examples/notify/docker-compose.yml`) | Real ntfy: title (UTF-8), priority, tags, click. Real apprise-api: stateless ntfy destination with priority and click; stateful routing by tag and "no tag matched" | 1, 10 |
| `E2E` workflow (`scripts/e2e/run.mjs` against a Paperclip host at a pinned commit) | Install from a local path, settings page slot, config saved with company secrets (host Ajv + secret binding), issue blocked → one notification per plugin with deep link, token and Cloudflare Access header resolved (events and send-test), status through the host bridge, two companies on different topics, unconfigured company gets nothing, outage → retry → delivered by the drain job (proved from the job run history), no secret in plugin logs | 1, 5, 7, 8, 10, 11 |

Run the E2E workflow against another Paperclip version from the Actions tab (`paperclip_ref` input).

## By hand

Use a local Paperclip (`pnpm dev` in a Paperclip checkout) with both plugins installed by path:

```bash
paperclipai plugin install /path/to/paperclip-plugins/packages/plugin-ntfy
paperclipai plugin install /path/to/paperclip-plugins/packages/plugin-apprise
```

- [ ] **Phone delivery (criterion 1).** Subscribe to the topic in the ntfy app. Block an issue: the notification shows the ⚠️ emoji, high priority, and opens the issue when tapped.
- [ ] **Approvals (criterion 3).** Create a board approval request, then approve, reject and request revision on three of them: the titles read "Approval approved", "Approval rejected" and "Revision requested".
- [ ] **Budget (criterion 4).** Set a small company budget with a warning percentage and hard stop; let an agent spend past both: the soft alert is high priority, the hard one urgent (priority 5).
- [ ] **Quiet hours (criterion 6).** Enable quiet hours around the current time, block two issues: nothing arrives; when the window ends, one "2 notifications since HH:MM" digest arrives within a minute.
- [ ] **Cloudflare Access (criterion 8).** Put ntfy behind Cloudflare Access with a service token. Configure `extraHeaders` with `CF-Access-Client-Id` and `CF-Access-Client-Secret` as secrets, press "Send test notification" on the settings page (`/<prefix>/company/settings/ntfy`): it arrives.
- [ ] **Private network (criterion 9).** Point ntfy at a server on the local network with `network.allowPrivateNetwork: false`: the send fails with a clear error in the status. Turn it on: it works.
- [ ] **Apprise destinations (criterion 10).** Stateful: a Telegram or e-mail URL tagged `alert` in apprise-api receives high-severity events only. Stateless: a destination with `minSeverity: urgent` receives only urgent ones.
- [ ] **Two companies (criterion 5).** Configure ntfy for two companies with different topics: each topic only gets its own company's events. (Also automated in E2E.)
- [ ] **Logs (criterion 11).** `GET /api/plugins/<id>/logs` and the server log contain no token, password, `configKey` or header value.
- [ ] **Release (criterion 12).** CI, Integration and E2E green on `main`; coverage at or above 90% (core) and 80% (plugins) in the CI log; after publishing, `npm view paperclip-plugin-ntfy --json` shows a provenance attestation (also on npmjs.com).

## Host notes

- Local installs need an instance admin (`POST /api/plugins/install { packageName, isLocalPath: true }`); cloud-managed instances refuse them.
- Config is per company (`POST /api/plugins/<id>/config { companyId, configJson }`), validated with Ajv; invalid config returns 400 with `fieldErrors`. The host logs one Ajv "strict mode" warning per secret field when it validates; this is harmless.
- Secret fields hold `{ type: "secret_ref", secretId }`; a bare UUID string is rejected with 422. The host allows 30 secret reads per minute per company and plugin.
- The host's "Test configuration" button checks structure only (it passes no company); use "Send test notification" on the plugin's company settings page.
- Jobs can be run by hand: `GET /api/plugins/<id>/jobs`, then `POST /api/plugins/<id>/jobs/<jobId>/trigger`.
