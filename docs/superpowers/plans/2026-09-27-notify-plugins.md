# Plugins de notificação (ntfy e Apprise) — plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para executar este plano tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** entregar `@rodolphobrock/paperclip-notify-core`, `paperclip-plugin-ntfy` e `paperclip-plugin-apprise` num pnpm workspace, publicados no npm com provenance.

**Arquitetura:** o core é uma biblioteca sem efeitos colaterais (portas e adaptadores) que cada plugin chama no `setup`; os plugins só implementam `NotificationSender<C>`, schema e manifest. O worker de cada plugin é empacotado com esbuild (presets do SDK), então o core entra no bundle.

**Stack:** Node ≥ 24.11, pnpm 9.15.9, TypeScript 6 (`strict`), esbuild 0.28, Vitest 5 + `@vitest/coverage-v8`, Biome 2.5, Changesets 2, GitHub Actions, `@paperclipai/plugin-sdk@2026.916.1`.

**Spec:** [docs/specs/2026-09-27-notify-plugins-design.md](../../specs/2026-09-27-notify-plugins-design.md)

## Restrições globais

- Node `>=24.11.0` (`engines` na raiz e nos pacotes); CI em Node 24.
- pnpm 9 (`packageManager: pnpm@9.15.9`); lockfile commitado.
- TypeScript `strict`, sem `any`; payloads de evento são `unknown` e passam por guardas de tipo.
- `@paperclipai/plugin-sdk` é `peerDependency` (`>=2026.916.1`) do core e dos plugins, e `devDependency` fixa em `2026.916.1`.
- Manifests com `apiVersion: 1`, ID igual ao nome do pacote e `version` lida do `package.json`; sem `minimumHostVersion` (ver "Desvios da spec").
- Nomes: plugins em `packages/plugin-<nome>` → `paperclip-plugin-<nome>`; bibliotecas em `packages/<família>-core` → `@rodolphobrock/paperclip-<família>-core`.
- Licença MIT em todos os pacotes.
- Fim de linha LF em tudo (`.gitattributes` com `eol=lf`); desenvolvimento no Windows com `npm_config_script_shell` apontando para o Git Bash.
- Nunca logar token, senha, `configKey` nem valor de header secreto.
- Cobertura mínima: 90% no core, 80% nos plugins (linhas, funções, branches, statements).
- Pacotes ficam com `"private": true` até a fase 7; o `release.yml` não publica nada antes disso.

## Pontos de atenção na revisão

1. **Payload fora do formato esperado** (campo ausente, tipo trocado, evento novo do core): o mapeador degrada para mensagem genérica com título do tipo do evento, nunca lança. Teste em cada mapeador da fase 2 com `payload: null`, `{}` e campos com tipo errado.
2. **Empresa sem configuração ou com `enabled: false`** recebendo evento: nada é enviado e nada é gravado em estado. Teste de harness na fase 3 (critério de aceite 5).
3. **Secret que falha ao resolver** (ref apagada, limite de 30 leituras/min): o envio falha com erro não retentável e mensagem sem o valor; o cache evita estourar o limite. Teste de contrato na fase 3.
4. **`paperclipBaseUrl` com barra final ou caminho** (`https://pc.exemplo/`, `https://exemplo/pc`): o link não pode ter `//` nem perder o caminho. Teste em `buildDeepLink` na fase 2.
5. **Horário de silêncio que cruza a meia-noite e fuso inválido** (`22:00–07:00`, `timezone: "Mars/Olympus"`): silêncio correto nos dois lados da meia-noite; fuso inválido rejeitado em `parseConfig` com mensagem clara. Testes na fase 4.

---

## Fase 1 — Base do monorepo e scaffold dos três pacotes

Resultado: `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` verde na raiz; CI e release configurados; três pacotes com código mínimo testado.

### Tarefa 1.1: Raiz do workspace

**Arquivos:**
- Criar: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.gitattributes`, `.gitignore`, `.editorconfig`, `.npmrc`
- Modificar: `README.md` (seção de desenvolvimento)

**Interfaces:**
- Produz: scripts de raiz `build`, `typecheck`, `test`, `test:coverage`, `lint`, `format`, `changeset`, `version-packages`, `release`, que delegam para `pnpm -r`. Cada pacote precisa expor `build`, `typecheck`, `test`, `test:coverage`.

- [ ] **Passo 1:** criar `.gitattributes` com `* text=auto eol=lf` e renormalizar (`git add --renormalize .`).
- [ ] **Passo 2:** criar `package.json` da raiz:

```json
{
  "name": "paperclip-plugins",
  "private": true,
  "type": "module",
  "license": "MIT",
  "packageManager": "pnpm@9.15.9",
  "engines": { "node": ">=24.11.0" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "test:coverage": "pnpm -r test:coverage",
    "lint": "biome check .",
    "format": "biome check --write .",
    "changeset": "changeset",
    "version-packages": "changeset version && pnpm install --lockfile-only",
    "release": "pnpm -r build && changeset publish"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.14",
    "@changesets/cli": "^2.31.1",
    "@types/node": "^24.19.0",
    "@vitest/coverage-v8": "^5.0.2",
    "esbuild": "^0.28.2",
    "typescript": "^6.0.3",
    "vitest": "^5.0.2"
  }
}
```

- [ ] **Passo 3:** `pnpm-workspace.yaml` com `packages: ["packages/*"]`; `.npmrc` com `engine-strict=true`.
- [ ] **Passo 4:** `tsconfig.base.json` (`target` ES2023, `module`/`moduleResolution` NodeNext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck`, `types: ["node"]`).
- [ ] **Passo 5:** `biome.json` com formatter (2 espaços, largura 100, aspas duplas), linter `recommended` + `noExplicitAny: error`, organize imports, `vcs.useIgnoreFile: true`.
- [ ] **Passo 6:** `.gitignore` (`node_modules`, `dist`, `coverage`, `*.tsbuildinfo`, `.paperclip-sdk`) e `.editorconfig` (LF, UTF-8, 2 espaços).
- [ ] **Passo 7:** `pnpm install`, depois `pnpm lint`. Esperado: sem erros.
- [ ] **Passo 8:** commit `chore: pnpm workspace, Biome, TypeScript base e LF`.

### Tarefa 1.2: `@rodolphobrock/paperclip-notify-core` (scaffold)

**Arquivos:**
- Criar: `packages/notify-core/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,README.md,CHANGELOG.md}`, `packages/notify-core/src/{index.ts,severity.ts}`, `packages/notify-core/src/severity.test.ts`

**Interfaces:**
- Produz: `SEVERITIES`, `type Severity`, `TONES`, `type Tone`, `compareSeverity(a: Severity, b: Severity): number`, `isSeverity(value: unknown): value is Severity`. Exportados de `src/index.ts`.
- Exports do pacote: em desenvolvimento `"." → "./src/index.ts"` (o esbuild e o Vitest dos plugins leem a fonte); `publishConfig.exports` aponta para `dist/` (build com `tsc -p tsconfig.build.json`).

- [ ] **Passo 1:** escrever `severity.test.ts` cobrindo ordem (`low < normal < high < urgent`), `compareSeverity` e `isSeverity` com string válida, inválida, `null` e número.
- [ ] **Passo 2:** `pnpm --filter @rodolphobrock/paperclip-notify-core test`. Esperado: falha, módulo inexistente.
- [ ] **Passo 3:** implementar `severity.ts` e `index.ts`.
- [ ] **Passo 4:** rodar testes, `typecheck`, `build`. Esperado: verde; `dist/index.js` e `dist/index.d.ts` gerados.
- [ ] **Passo 5:** commit `feat(notify-core): scaffold com severidades e tons`.

### Tarefa 1.3: `paperclip-plugin-ntfy` e `paperclip-plugin-apprise` (scaffold)

**Arquivos (para cada `<nome>` em `ntfy`, `apprise`):**
- Criar: `packages/plugin-<nome>/{package.json,tsconfig.json,esbuild.config.mjs,vitest.config.ts,README.md,CHANGELOG.md}`, `src/{manifest.ts,worker.ts}`, `tests/plugin.spec.ts`

**Interfaces:**
- Consome: `SEVERITIES` do core (prova que o workspace resolve e que o esbuild empacota o core).
- Produz: manifest `PaperclipPluginManifestV1` com `id: "paperclip-plugin-<nome>"`, `categories: ["connector"]`, `capabilities: ["events.subscribe"]`, `entrypoints.worker: "./dist/worker.js"`; worker `definePlugin({ setup, onHealth })` com `runWorker(plugin, import.meta.url)`. `package.json` com `paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" }`.

- [ ] **Passo 1:** escrever `tests/plugin.spec.ts`: manifest tem ID e versão iguais aos do `package.json` e não declara `minimumHostVersion`; `createTestHarness({ manifest })` + `plugin.definition.setup(harness.ctx)` não lança; `onHealth()` devolve `status: "ok"` e cita as severidades conhecidas.
- [ ] **Passo 2:** rodar o teste. Esperado: falha, módulos inexistentes.
- [ ] **Passo 3:** implementar `manifest.ts`, `worker.ts`, `esbuild.config.mjs` (presets do SDK, sem UI por enquanto).
- [ ] **Passo 4:** `pnpm test && pnpm typecheck && pnpm build` na raiz. Esperado: `dist/manifest.js` e `dist/worker.js` em cada plugin.
- [ ] **Passo 5:** commit `feat: scaffold dos plugins ntfy e apprise`.

### Tarefa 1.4: CI, Changesets e release

**Arquivos:**
- Criar: `.changeset/config.json`, `.changeset/README.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [ ] **Passo 1:** `.changeset/config.json` com `baseBranch: "main"`, `access: "public"`, `updateInternalDependencies: "patch"`, `changelog: "@changesets/cli/changelog"`.
- [ ] **Passo 2:** `ci.yml`: em `pull_request` e `push` para `main`; `pnpm/action-setup@v4`, `actions/setup-node@v4` (Node 24, cache pnpm), `pnpm install --frozen-lockfile`, `pnpm lint`, e depois typecheck, `test:coverage` e build. Em PR, filtra `--filter "...[origin/${{ github.base_ref }}]"`; em push, roda tudo.
- [ ] **Passo 3:** `release.yml`: em push para `main`, `changesets/action@v1` com `version: pnpm version-packages` e `publish: pnpm release`; `permissions: contents: write, pull-requests: write, id-token: write`; `NPM_CONFIG_PROVENANCE: true`. Publicação por trusted publishing (sem `NPM_TOKEN`), configurada no npm na fase 7.
- [ ] **Passo 4:** validar localmente o que o CI roda (`pnpm install --frozen-lockfile`, lint, typecheck, `test:coverage`, build) e `pnpm changeset status`.
- [ ] **Passo 5:** commit `ci: workflows de CI e release com changesets`.

---

## Fases seguintes

As fases 2 a 7 têm arquivos, interfaces e casos de teste definidos aqui. O código detalhado de cada passo é escrito numa revisão deste plano no começo de cada fase, porque dois pontos em aberto da spec (campo que distingue limite suave e rígido de orçamento; autor em `issue.comment.created`) mudam o código dos mapeadores e só se resolvem lendo os payloads reais em `D:\tmp\pc\server`.

### Fase 2 — Core: contratos, mapeadores, política, dedupe, deep links

| Tarefa | Arquivos (`packages/notify-core/src/`) | Interface produzida | Testes |
| --- | --- | --- | --- |
| 2.1 Contratos | `types.ts` | `Notification`, `SendResult`, `NotificationSender<C>`, `SenderDeps`, `BaseConfig`, `SecretRef` (decisão 3) | tipos compilam; `isSecretRef` |
| 2.2 Classificação HTTP | `http-result.ts` | `classifyResponse(res: Response): Promise<SendResult>`, `classifyError(err: unknown): SendResult`, `parseRetryAfter(header, now): number \| undefined` | 2xx, 400, 401, 404, 429 com e sem `Retry-After` (segundos e data), 500, 503, `AbortError`, `TypeError` de rede |
| 2.3 Configuração comum | `config.ts`, `config-schema.ts` | `baseConfigSchema` (fragmento JSON Schema), `parseBaseConfig(raw: unknown): BaseConfig` com defaults da decisão 7 | defaults, valores inválidos, `events` parcial mesclado com a tabela da decisão 4 |
| 2.4 Mapeadores | `events/catalog.ts`, `events/<tipo>.ts`, `events/guards.ts` | `EVENT_CATALOG`, `mapEvent(event: PluginEvent, enrich: Enrichment): Notification \| null` | cada linha da tabela da decisão 4; payload `null`/`{}`/tipo errado → genérico; título ≤ 120 |
| 2.5 Política | `policy.ts` | `applyPolicy(n, config, meta): { pass: true } \| { pass: false; reason: "disabled" \| "severity" \| "filter" }` | `minSeverity`, override por evento, filtros de projeto e agente |
| 2.6 Dedupe | `dedupe.ts` | `semanticKey(event, n): string`, `DedupeStore` (anel de 500, TTL 10 min, `ctx.state` escopo `company`, namespace `notify`, chave `dedupe`) | mesma chave duas vezes; TTL expirado; anel cheio descarta a mais antiga |
| 2.7 Deep links | `links.ts` | `buildDeepLink(base, prefix, target): string \| undefined`, cache de `issuePrefix` 10 min | barra final, caminho na base, sem base → `undefined` e aviso único por empresa |
| 2.8 Orquestração | `notifier.ts` | `createNotifier({ sender, parseConfig })` com um `events.on` por tipo; enriquecimento com degradação | harness: registra o handler duas vezes (simula #13732) e sai uma notificação; empresa sem config não envia |

Cobertura do core ≥ 90% ao fim da fase (`vitest.config.ts` com `thresholds`).

### Fase 3 — Plugin ntfy v0.1

| Tarefa | Arquivos (`packages/plugin-ntfy/src/`) | Testes |
| --- | --- | --- |
| 3.1 Config e schema | `config.ts`, `schema.ts` | `parseNtfyConfig`: `topic` obrigatório, `serverUrl` padrão, `auth` por modo, `extraHeaders` |
| 3.2 Sender | `sender.ts` | contrato: URL `POST {serverUrl}/{topic}`, `topicsBySeverity`, headers `Title`/`Priority`/`Tags`/`Click`/`Markdown`/`Icon`/`Authorization` (Bearer e Basic), headers extras resolvidos; título com acento em header (codificação RFC 2047 ou `X-Title` com UTF-8, decidir lendo a doc do ntfy); erro de secret não vaza valor |
| 3.3 Rede | `fetch-selector.ts` no core | `allowPrivateNetwork` escolhe `ctx.http.fetch` ou `fetch` global com timeout de 10 s |
| 3.4 Manifest e worker | `manifest.ts`, `worker.ts` | capabilities da decisão 4; `instanceConfigSchema`; harness `emit` → uma chamada de `fetch` por evento padrão; `performAction("send-test")` |
| 3.5 Página | `ui/index.tsx`, `ctx.data.register("status")` | slot `companySettingsPage` `routePath: "ntfy"`; harness `getData("status")` |

### Fase 4 — Core v0.2: entrega

Tarefas: `quiet-hours.ts` (`isQuiet(now, cfg)`, relógio injetado, cruzamento de meia-noite, fuso IANA validado), `rate-limit.ts` (token bucket por empresa), `digest.ts` (fila e mensagem "N eventos desde HH:MM", 10 linhas), `retry.ts` (backoff 30 s × 2ⁿ, `maxAttempts`, `maxAgeMinutes`, `notify.dropped` + `ctx.activity.log`), job `delivery-drain` (`*/1 * * * *`), `onShutdown` grava filas, `observability.ts` (logs e métricas da decisão 13), `onHealth` degradado. Cada módulo com relógio falso e harness `runJob("delivery-drain")`.

### Fase 5 — Plugin Apprise

Mesmo formato da fase 3: `config.ts` (`apiUrl`, `configKey` secret-ref, `tagsBySeverity`, `format`, `auth`, `extraHeaders`), `sender.ts` (`POST {apiUrl}/notify/{configKey}`, JSON `{ title, body, type, tag, format }`, link no fim do corpo), manifest, página `routePath: "apprise"`. Testes de contrato e de harness; cobertura ≥ 80%.

### Fase 6 — Integração e ponta a ponta

`examples/notify/docker-compose.yml` (ntfy + apprise-api); teste de integração opcional (`pnpm test:integration`, fora do CI padrão) que envia para os containers; roteiro manual dos 12 critérios de aceite numa instância local (`paperclipai plugin install <caminho>`), incluindo ntfy atrás do Cloudflare Access.

### Fase 7 — Documentação e release

READMEs dos três pacotes (instalação, configuração, risco de `allowPrivateNetwork`, eventos perdidos em reinício), remover `"private": true`, configurar trusted publishing no npm para cada pacote, primeira changeset, job de compatibilidade do CI contra `@paperclipai/plugin-sdk@latest` e `@beta`, PR no awesome-paperclip, comentários na #26, #2897 e #3257.

## Desvios da spec

- **Tags de release:** a spec pede `v<pacote>@<versão>`; o Changesets gera `<pacote>@<versão>` e não tem opção para mudar o formato. O plano usa o padrão do Changesets.
- **Escopo npm:** a spec deixa em aberto; o plano usa `@rodolphobrock`.
- **Core nos plugins:** o core entra como `devDependency` dos plugins, porque o esbuild o empacota no worker; ele não é carregado em tempo de execução.
- **`minimumHostVersion`:** a spec (decisão 15) pede `"2026.916.1"`, mas o servidor do Paperclip passa `hostVersion` `"0.0.0"` ao carregador de plugins (`server/src/app.ts`, `opts.hostVersion ?? "0.0.0"`; `server/src/index.ts` não informa a versão), e o carregador recusa a instalação. Os manifests não declaram o campo; a compatibilidade fica no `peerDependency` do SDK. Vale citar no PR upstream da decisão 14.
