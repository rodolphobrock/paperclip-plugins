# Plugins de notificação (ntfy e Apprise) — plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para executar este plano tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** entregar `paperclip-plugin-ntfy` e `paperclip-plugin-apprise`, publicados no npm com provenance, e a biblioteca interna `@paperclip-plugins/notify-core` (privada, embutida nos plugins), num pnpm workspace.

**Arquitetura:** o core é uma biblioteca sem efeitos colaterais (portas e adaptadores) que cada plugin chama no `setup`; os plugins só implementam `NotificationSender<C>`, schema e manifest. O worker de cada plugin é empacotado com esbuild (presets do SDK), então o core entra no bundle.

**Stack:** Node ≥ 24.11, pnpm 9.15.9, TypeScript 6 (`strict`), esbuild 0.28, Vitest 5 + `@vitest/coverage-v8`, Biome 2.5, Changesets 2, GitHub Actions, `@paperclipai/plugin-sdk@2026.916.1`.

**Spec:** [docs/specs/2026-09-27-notify-plugins-design.md](../../specs/2026-09-27-notify-plugins-design.md)

## Restrições globais

- Node `>=24.11.0` (`engines` na raiz e nos pacotes); CI em Node 24.
- pnpm 9 (`packageManager: pnpm@9.15.9`); lockfile commitado.
- TypeScript `strict`, sem `any`; payloads de evento são `unknown` e passam por guardas de tipo.
- `@paperclipai/plugin-sdk`: nos plugins, `peerDependency` (`>=2026.916.1`) e `devDependency` fixa em `2026.916.1`; no core, só `devDependency` e `import type`.
- Manifests com `apiVersion: 1`, ID igual ao nome do pacote e `version` lida do `package.json`; sem `minimumHostVersion` (ver "Desvios da spec").
- Nomes: plugins em `packages/plugin-<nome>` → `paperclip-plugin-<nome>`; bibliotecas em `packages/<família>-core` → `@paperclip-plugins/<família>-core`, sempre `"private": true`, `devDependency` (`workspace:*`) dos plugins e embutidas no `worker.js` pelo esbuild.
- Licença MIT em todos os pacotes.
- Fim de linha LF em tudo (`.gitattributes` com `eol=lf`); desenvolvimento no Windows com `npm_config_script_shell` apontando para o Git Bash.
- Nunca logar token, senha, `configKey` nem valor de header secreto.
- Cobertura mínima: 90% no core, 80% nos plugins (linhas, funções, branches, statements).
- Os plugins ficam com `"private": true` até a fase 7; o `release.yml` não publica nada antes disso.

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

### Tarefa 1.2: `@paperclip-plugins/notify-core` (scaffold)

**Arquivos:**
- Criar: `packages/notify-core/{package.json,tsconfig.json,vitest.config.ts,README.md,CHANGELOG.md}`, `packages/notify-core/src/{index.ts,severity.ts}`, `packages/notify-core/src/severity.test.ts`

**Interfaces:**
- Produz: `SEVERITIES`, `type Severity`, `TONES`, `type Tone`, `compareSeverity(a: Severity, b: Severity): number`, `isSeverity(value: unknown): value is Severity`. Exportados de `src/index.ts`.
- Exports do pacote: `"." → "./src/index.ts"` (o esbuild e o Vitest dos plugins leem a fonte). Sem build próprio: o pacote é privado e só existe embutido nos plugins.

- [ ] **Passo 1:** escrever `severity.test.ts` cobrindo ordem (`low < normal < high < urgent`), `compareSeverity` e `isSeverity` com string válida, inválida, `null` e número.
- [ ] **Passo 2:** `pnpm --filter @paperclip-plugins/notify-core test`. Esperado: falha, módulo inexistente.
- [ ] **Passo 3:** implementar `severity.ts` e `index.ts`.
- [ ] **Passo 4:** rodar testes e `typecheck`. Esperado: verde.
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

As fases 3 a 7 têm arquivos, interfaces e casos de teste definidos aqui; o detalhamento de cada uma é escrito no começo da fase. A fase 2 foi detalhada a partir dos payloads reais do servidor (`D:\tmp\pc`, commit `0f14d26`).

### Fase 2 — Core: contratos, mapeadores, política, dedupe, deep links

#### Fatos levantados no código do Paperclip (`0f14d26`) que mudam a spec

| Ponto | O que o servidor faz | Consequência |
| --- | --- | --- |
| Limite suave × rígido | Os dois viram `budget.incident.opened` sem campo de tipo; só o rígido tem a chave `approvalId` no payload (`server/src/services/budgets.ts:673-713`) | `"approvalId" in payload` → rígido (urgent); senão → suave (high) |
| `approval.decided` | Sem status no payload (`routes/approvals.ts:305-458`) | Status só via `ctx.approvals.get`; sem ele, título "Aprovação decidida", tom `info` |
| `agent.status_changed` | Declarado, nunca emitido | Fora do catálogo |
| `agent.run.failed` | Envelope `entityType: "heartbeat_run"`; payload `{ runId, agentId, status: "failed" \| "timed_out", error, errorCode, issueId, … }` (`heartbeat.ts:12991`) | Título diferencia falha e timeout; nome do agente via `ctx.agents.get` |
| `issue.updated` | Status em formatos diferentes: `status` + `_previous.status` (rota principal), `status` + `previousStatus` (wake-queue), `patch.status` + `_previous.status` (rota de plugin), às vezes só `status` | Status novo = `status ?? patch.status`; anterior = `_previous.status ?? previousStatus`; notifica quando há status novo e ele difere do anterior (anterior ausente conta como mudança) |
| `issue.comment.created` | Autor só no envelope (`actorType`/`actorId`); responsável não vem no payload; `identifier`/`issueTitle` nem sempre presentes | Ignora quando `actorType === "agent"` e `actorId` é o `assigneeAgentId` da issue (`ctx.issues.get`) |
| `issue.created` | Payload com `title`, `identifier`, `status`; sem `projectId` | Filtro por projeto usa `ctx.issues.get` quando há filtro |
| Envelope | `eventId` novo a cada escrita no log de atividade; payload sempre com `agentId` (agente que agiu), `runId` | Chave semântica por fato; `agentId` do payload alimenta o filtro de agentes |
| Secrets | Valor salvo `{ type: "secret_ref", secretId, version? }`; tipo `EnvSecretRefBinding` exportado pelo SDK | `SecretRef = EnvSecretRefBinding` |
| Harness | `secrets.resolve` devolve `"resolved:…"`; `config.get` ignora empresa; `seed({ companies, approvals, agents, issues })` alimenta os `get` | Testes do orquestrador usam `seed` e um sender falso |

#### Estrutura (`packages/notify-core/src/`)

| Arquivo | Responsabilidade |
| --- | --- |
| `types.ts` | `Notification`, `SendResult`, `NotificationSender<C>`, `SenderDeps`, `SecretRef`, `LinkTarget` |
| `guards.ts` | `isRecord`, `readString`, `readNumber`, `isSecretRef` |
| `http-result.ts` | `classifyResponse`, `classifyError`, `parseRetryAfter` |
| `catalog.ts` | `SUBSCRIBED_EVENT_TYPES`, `RuleKey`, `DEFAULT_RULES` |
| `config.ts` | `BaseConfig`, `baseConfigSchema`, `parseBaseConfig`, `ConfigError` |
| `mappers.ts` | `mapEvent(event, facts): NotificationDraft \| null` (puro) |
| `enrich.ts` | `collectFacts(event, ports, logger, needsIssue): Promise<EventFacts>` (bordas, com degradação) |
| `policy.ts` | `applyPolicy(draft, config)` |
| `dedupe.ts` | `semanticKey`, `DedupeStore` sobre uma porta de estado |
| `links.ts` | `buildDeepLink`, `PrefixCache` |
| `notifier.ts` | `createNotifier` |

#### Interfaces

```ts
// types.ts
import type { EnvSecretRefBinding, PluginEventType, PluginLogger } from "@paperclipai/plugin-sdk";
export type SecretRef = EnvSecretRefBinding;
export type LinkTarget =
  | { kind: "issue"; identifier: string }
  | { kind: "approval"; approvalId: string }
  | { kind: "run"; agentId: string; runId: string };
export interface Notification {
  key: string; companyId: string; eventType: PluginEventType; severity: Severity; tone: Tone;
  title: string; body: string; url?: string; tags: string[]; occurredAt: string;
}
export type SendResult = { ok: true } | { ok: false; retryable: boolean; error: string; retryAfterMs?: number };
export interface SenderDeps {
  fetch: typeof fetch;
  resolveSecret(ref: SecretRef, configPath: string): Promise<string>;
  logger: PluginLogger;
}
export interface NotificationSender<C> {
  readonly name: string;
  send(n: Notification, config: C, deps: SenderDeps): Promise<SendResult>;
  sendTest(config: C, deps: SenderDeps): Promise<SendResult>;
}

// catalog.ts — chave de regra = tipo de evento, ou tipo.variante quando a condição muda a severidade
export type RuleKey =
  | "approval.created" | "approval.decided" | "agent.run.failed" | "agent.run.finished"
  | "budget.incident.opened.hard" | "budget.incident.opened.soft" | "budget.incident.resolved"
  | "issue.updated.blocked" | "issue.updated.done" | "issue.created" | "issue.comment.created";
export const SUBSCRIBED_EVENT_TYPES: readonly PluginEventType[]; // 9 tipos, um events.on cada
export const DEFAULT_RULES: Readonly<Record<RuleKey, { enabled: boolean; severity: Severity }>>;

// config.ts
export interface BaseConfig {
  enabled: boolean;
  paperclipBaseUrl?: string;
  events: Record<RuleKey, { enabled: boolean; severity: Severity }>;
  minSeverity: Severity;
  filters: { projectIds: string[]; agentIds: string[] };
  network: { allowPrivateNetwork: boolean };
}
export class ConfigError extends Error { readonly issues: string[] }
export function parseBaseConfig(raw: unknown): BaseConfig;   // lança ConfigError com todos os problemas
export const baseConfigSchema: { properties: Record<string, JsonSchema> };

// mappers.ts
export interface EventFacts {
  approval?: { status: string; type: string };
  agentName?: string;
  issue?: { assigneeAgentId: string | null; projectId: string | null; identifier: string | null; title: string };
}
export interface NotificationDraft {
  rule: RuleKey; eventType: PluginEventType; severity: Severity; tone: Tone;
  title: string; body: string; tags: string[]; link?: LinkTarget;
  factKey: string;          // estado relevante do fato para a chave semântica
  scope: { projectId?: string; agentId?: string };
}
export function mapEvent(event: PluginEvent, facts: EventFacts): NotificationDraft | null;

// enrich.ts
export interface HostPorts {
  getApproval(id: string, companyId: string): Promise<{ status: string; type: string } | null>;
  getAgentName(id: string, companyId: string): Promise<string | null>;
  getIssue(id: string, companyId: string): Promise<EventFacts["issue"] | null>;
}
export function collectFacts(event: PluginEvent, ports: HostPorts, logger: PluginLogger, needsIssue: boolean): Promise<EventFacts>;

// policy.ts
export type PolicyResult = { pass: true; severity: Severity } | { pass: false; reason: "disabled" | "severity" | "filter" };
export function applyPolicy(draft: NotificationDraft, config: BaseConfig): PolicyResult;

// dedupe.ts
export interface StatePort { get(): Promise<unknown>; set(value: unknown): Promise<void> }
export function semanticKey(eventType: string, entityId: string | undefined, factKey: string): string;
export class DedupeStore {
  constructor(state: StatePort, opts?: { capacity?: number; ttlMs?: number });  // 500, 600_000
  seen(keys: string[], now: number): Promise<boolean>;   // true se alguma chave está no anel e não expirou
  remember(keys: string[], now: number): Promise<void>;
}

// links.ts
export function buildDeepLink(baseUrl: string | undefined, issuePrefix: string, target: LinkTarget): string | undefined;
export class PrefixCache {
  constructor(load: (companyId: string) => Promise<string | null>, clock: () => number, ttlMs?: number); // 600_000
  get(companyId: string): Promise<string | null>;
}

// notifier.ts
export interface NotifierOptions<C extends BaseConfig> {
  sender: NotificationSender<C>;
  parseConfig(raw: unknown): C;
  clock?: () => number;
}
export function createNotifier<C extends BaseConfig>(opts: NotifierOptions<C>): { setup(ctx: PluginContext): Promise<void> };
```

#### Regras de mapeamento (`mapEvent`)

| Evento | Condição | Regra | Tom | Título | Link | `factKey` |
| --- | --- | --- | --- | --- | --- | --- |
| `approval.created` | sempre | `approval.created` | warning | "Aprovação pendente: {tipo legível}" | approval | `created` |
| `approval.decided` | `facts.approval.status` | `approval.decided` | approved → success; rejected → failure; revision_requested → warning; outro/ausente → info | "Aprovação {aprovada\|rejeitada\|com revisão pedida\|decidida}: {tipo}" | approval | status ou `unknown` |
| `agent.run.failed` | sempre | `agent.run.failed` | failure | "{agente} falhou" ou "{agente} excedeu o tempo" (`status: "timed_out"`); agente = `facts.agentName ?? "Agente"` | run | `failed` |
| `agent.run.finished` | sempre | `agent.run.finished` | success | "{agente} concluiu uma execução" | run | `finished` |
| `budget.incident.opened` | `"approvalId" in payload` | `.hard` | failure | "Limite de orçamento atingido" | — | `hard` |
| `budget.incident.opened` | senão | `.soft` | warning | "Orçamento perto do limite" | — | `soft` |
| `budget.incident.resolved` | sempre | `budget.incident.resolved` | success | "Incidente de orçamento resolvido" | — | `resolved` |
| `issue.updated` | status novo `blocked`, diferente do anterior | `.blocked` | warning | "{identifier} bloqueada" | issue | `blocked` |
| `issue.updated` | status novo `done`, diferente do anterior | `.done` | success | "{identifier} concluída" | issue | `done` |
| `issue.created` | sempre | `issue.created` | info | "Nova issue {identifier}: {title}" | issue | `created` |
| `issue.comment.created` | ator não é o agente responsável | `issue.comment.created` | info | "Comentário em {identifier}" | issue | `commentId` ou `eventId` |

- Qualquer outro caso → `null` (ignorado). Payload que não é objeto ou sem os campos esperados → o mapeador usa o que houver; faltando identificador, o título usa "Issue" e a notificação sai sem link.
- Títulos são truncados em 120 caracteres (reticências `…`). Corpo: 1–3 linhas com os dados disponíveis (valores e limite do orçamento, erro da execução, trecho do comentário).
- Severidade do rascunho = `DEFAULT_RULES[rule].severity`; a política troca pela da configuração.
- `tags`: tipo curto (`approval`, `run`, `budget`, `issue`, `comment`) e `agent:{nome}` quando conhecido.

#### Orquestração (`createNotifier().setup(ctx)`)

1. Registra exatamente um `ctx.events.on` por tipo de `SUBSCRIBED_EVENT_TYPES`.
2. Para cada evento, serializa por empresa (fila de promessas em memória, evita corrida no anel de dedupe).
3. `ctx.config.get(companyId)`; objeto vazio ou `enabled: false` → para, sem gravar estado. `ConfigError` → `logger.warn` uma vez por empresa e para.
4. `collectFacts` só com as consultas que o evento pede (`approval.*` → approval; `agent.run.*` → nome do agente; `issue.comment.created`, ou filtro de projeto ligado para eventos de issue → issue). Consulta que falha: `logger.warn("notify.enrich_failed")`, segue sem o dado.
5. `mapEvent` → `null` para. `applyPolicy` reprovado → `logger.debug("notify.suppressed", { reason })` e métrica `notify.suppressed`.
6. Chaves `eventId:{id}` e `semanticKey(...)`; `DedupeStore` em `ctx.state` (`scopeKind: "company"`, `scopeId: companyId`, `namespace: "notify"`, `stateKey: "dedupe"`). Vista → métrica `notify.deduped` e para. A chave é gravada antes do envio (no máximo uma tentativa por fato).
7. Link: `buildDeepLink(config.paperclipBaseUrl, prefixo, alvo)`; sem `paperclipBaseUrl` → `logger.warn` uma vez por empresa.
8. `SenderDeps`: `fetch` = `ctx.http.fetch` ou, com `network.allowPrivateNetwork`, o `fetch` global com timeout de 10 s (`AbortSignal.timeout`); `resolveSecret` com cache em memória de 5 min por empresa + `secretId` + `version`.
9. `sender.send`: ok → `logger.info("notify.sent")` + métrica `notify.sent`; falha → `logger.error("notify.failed", { error, retryable })` + métrica `notify.failed` (retry chega na fase 4). Exceção do sender é tratada como falha retentável.

#### Tarefas

- [ ] **2.1 Contratos e guardas** — `types.ts`, `guards.ts` + `guards.test.ts` (`isRecord` com objeto/array/null; `readString`/`readNumber` com tipo certo, errado e ausente; `isSecretRef` com `{ type: "secret_ref", secretId }`, sem `secretId`, tipo errado, string). Commit `feat(notify-core): contratos e guardas`.
- [ ] **2.2 Classificação HTTP** — `http-result.ts` + teste: 200/204 ok; 400/401/404 não retentável com status no erro; 429 com `Retry-After: 30` → 30 000 ms, com data HTTP → diferença até `now`, inválido → sem `retryAfterMs`; 500/503 retentável; `DOMException` `AbortError`/`TimeoutError` e `TypeError` retentáveis; erro desconhecido retentável. A mensagem de erro inclui no máximo 200 caracteres do corpo. Commit `feat(notify-core): classificação de respostas HTTP`.
- [ ] **2.3 Catálogo e configuração** — `catalog.ts`, `config.ts` + teste: defaults completos a partir de `{}`; `events` parcial mesclado; severidade inválida, `minSeverity` inválido, `paperclipBaseUrl` que não é http(s), filtros que não são lista de strings → `ConfigError` com todos os problemas; `paperclipBaseUrl` com barra final é normalizado; `baseConfigSchema` tem uma propriedade por campo. Commit `feat(notify-core): catálogo de eventos e configuração comum`.
- [ ] **2.4 Mapeadores** — `mappers.ts` + teste: uma asserção por linha da tabela; `approval.decided` sem fatos → info; `timed_out`; orçamento rígido com `approvalId: null`; `issue.updated` nos quatro formatos de status e sem mudança real → `null`; comentário do responsável → `null`, de usuário → notificação; payload `null`, `{}` e campos com tipo trocado não lançam; título de 300 caracteres truncado em 120. Commit `feat(notify-core): mapeadores de eventos`.
- [ ] **2.5 Enriquecimento** — `enrich.ts` + teste com portas falsas: só chama a porta que o evento pede; porta que lança → fato ausente e um `warn`. Commit `feat(notify-core): enriquecimento com degradação`.
- [ ] **2.6 Política** — `policy.ts` + teste: regra desligada; override de severidade; `minSeverity`; filtro de agente (casa, não casa, agente desconhecido com filtro → bloqueia); filtro de projeto idem. Commit `feat(notify-core): política de filtros e severidade`.
- [ ] **2.7 Dedupe** — `dedupe.ts` + teste: chave repetida dentro do TTL → vista; depois do TTL → nova; anel cheio descarta a mais antiga; estado corrompido (não lista) → começa vazio. Commit `feat(notify-core): deduplicação por chave semântica`.
- [ ] **2.8 Deep links** — `links.ts` + teste: três alvos; base com barra final e com caminho (`https://h/pc`); base ausente → `undefined`; identificador com caracteres especiais é codificado; `PrefixCache` chama o carregador uma vez dentro do TTL e de novo depois. Commit `feat(notify-core): deep links`.
- [ ] **2.9 Orquestrador** — `notifier.ts` + `notifier.test.ts` com `createTestHarness`, `seed` e sender falso: evento padrão gera um envio com título, severidade e link certos; `setup` chamado duas vezes (simula #13732) → um envio; mesmo fato com `eventId` diferente → um envio; empresa sem config → nenhum envio e nenhum estado; `enabled: false` → nenhum; config inválida → um `warn` só em dois eventos; falha de enriquecimento → envio sem o dado; falha do sender → `notify.failed`; `allowPrivateNetwork` escolhe o `fetch` global; `resolveSecret` usa cache. Commit `feat(notify-core): orquestrador createNotifier`.

Cobertura do core ≥ 90% ao fim da fase (`vitest.config.ts` com `thresholds`). Verificação da fase: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build`.

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

### Fase 5 — Plugin Apprise (com e sem estado)

Mesmo formato da fase 3. `config.ts`: `mode` (`stateful` padrão | `stateless`), `apiUrl`, `configKey` secret-ref (obrigatório com estado), `tagsBySeverity` (só com estado), `destinations: [{ url: secret-ref, minSeverity }]` (obrigatório sem estado, ao menos um), `format`, `auth`, `extraHeaders`. `sender.ts`: com estado, `POST {apiUrl}/notify/{configKey}` com `{ title, body, type, tag, format }`; sem estado, `POST {apiUrl}/notify` com `{ urls, title, body, type, format }`, filtrando destinos por `minSeverity` e acrescentando `priority`, `tags` e `click` às URLs `ntfy://`/`ntfys://`; link no fim do corpo para os demais. URLs resolvidas nunca aparecem em logs, erros ou status (só o esquema, como `tgram://…`). Manifest e página `routePath: "apprise"`. Testes de contrato dos dois modos e de harness; cobertura ≥ 80%.

### Fase 6 — Integração e ponta a ponta

`examples/notify/docker-compose.yml` (ntfy + apprise-api); teste de integração opcional (`pnpm test:integration`, fora do CI padrão) que envia para os containers; roteiro manual dos 12 critérios de aceite numa instância local (`paperclipai plugin install <caminho>`), incluindo ntfy atrás do Cloudflare Access.

### Fase 7 — Documentação e release

READMEs dos plugins e do core (instalação, configuração, risco de `allowPrivateNetwork`, eventos perdidos em reinício), remover `"private": true` dos plugins (o core continua privado), conferir se os nomes seguem livres no npm, configurar trusted publishing no npm para cada pacote, primeira changeset, job de compatibilidade do CI contra `@paperclipai/plugin-sdk@latest` e `@beta`, PR no awesome-paperclip, comentários na #26, #2897 e #3257.

## Desvios da spec

- **Tags de release:** a spec pede `v<pacote>@<versão>`; o Changesets gera `<pacote>@<versão>` e não tem opção para mudar o formato. O plano usa o padrão do Changesets.
- **`minimumHostVersion`:** a spec (decisão 15) pede `"2026.916.1"`, mas o servidor do Paperclip passa `hostVersion` `"0.0.0"` ao carregador de plugins (`server/src/app.ts`, `opts.hostVersion ?? "0.0.0"`; `server/src/index.ts` não informa a versão), e o carregador recusa a instalação. Os manifests não declaram o campo; a compatibilidade fica no `peerDependency` do SDK. Vale citar no PR upstream da decisão 14.
