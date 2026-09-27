# Plugins de notificação para o Paperclip — ntfy e Apprise

## Contexto

O Paperclip não tem notificação push fora da própria interface. Pedidos em aberto, todos sem resposta de maintainer:

- [paperclipai/paperclip#26](https://github.com/paperclipai/paperclip/issues/26): push via ntfy.sh (aberta pelo maintainer gsxdsm, sem corpo).
- [paperclipai/paperclip#2897](https://github.com/paperclipai/paperclip/issues/2897): push/webhooks para eventos do operador.
- [paperclipai/paperclip#3257](https://github.com/paperclipai/paperclip/issues/3257): notificações do board por e-mail/webhook.

Tentativas anteriores no core (#303, #389 com ntfy, #393) e como plugin dentro do monorepo (#398, #402, #407, #4974) não foram mergeadas. O maintainer pediu "implement these as plugins" (#389). O `CONTRIBUTING.md`, o `ROADMAP.md` ("thin core and rich edges") e o `PLUGIN_SPEC.md` ("Published npm packages are the intended install artifact") definem o caminho: pacote npm próprio, fora do monorepo, divulgado no [awesome-paperclip](https://github.com/gsxdsm/awesome-paperclip). É assim que existem os notifiers de comunidade (`paperclip-plugin-discord`, `-slack`, `-telegram`).

## Objetivo

Três pacotes neste repositório (`rodolphobrock/paperclip-plugins`); só os dois plugins são publicados no npm:

| Pacote | Tipo | Papel |
| --- | --- | --- |
| `@paperclip-plugins/notify-core` | biblioteca interna (`private`, não publicada) | Pipeline comum: eventos → mensagem normalizada → filtros → dedupe → silêncio → limite/digest → envio → retry. Contrato `NotificationSender`. |
| `paperclip-plugin-ntfy` | plugin | Sender ntfy com prioridade, tags, link de clique, autenticação e headers extras. |
| `paperclip-plugin-apprise` | plugin | Sender apprise-api nos modos com estado (rota por tag) e sem estado (destinos por URL). |

Fecha a #26 e cobre boa parte da #2897 e da #3257 sem tocar no core.

## Fora de escopo

- Qualquer mudança no core do Paperclip dentro deste trabalho (o PR opcional do bug 13732 é trabalho separado, ver decisão 14).
- Botões de ação na notificação que aprovam/rejeitam: planejados para a v0.3 (ver "Roadmap"), não entram nesta entrega.
- Web Push no navegador (#597, #755).
- Garantia de entrega: o barramento de eventos do host não persiste eventos (ver "Fatos").

## Alternativas consideradas

| Alternativa | Decisão | Motivo |
| --- | --- | --- |
| PR no core ou em `packages/plugins/` do Paperclip | descartada | Política do repositório (plugins de terceiros vão para o npm), nenhum notifier da comunidade mergeado até hoje, CI trava pacote novo (lockfile proibido em PR, Dockerfile, manifest de release). |
| Só ntfy nativo | parcial | Recursos completos do ntfy (prioridade, tags, clique por evento), mas público estreito. |
| Só Apprise | parcial | Mais de 100 destinos com um plugin, mas perde prioridade e link de clique por evento no modo com estado e exige o container do apprise-api. |
| Um plugin híbrido (ntfy + Apprise como backends) | descartada | Configuração condicionada ao backend, permissões somadas, nome genérico ruim para descoberta. |
| **Dois plugins + biblioteca comum** | **escolhida** | Responsabilidade única, configuração enxuta, nomes fáceis de achar, mesmo padrão dos notifiers da comunidade; a parte cara fica na biblioteca. A biblioteca é interna (fonte única no repositório, embutida no build de cada plugin), então só dois pacotes vão para o npm e não é preciso escopo. Publicá-la fica para quando alguém quiser escrever outro notifier com ela. |
| Um repositório por plugin | descartada | CI, lint e release repetidos; atualização do SDK em vários lugares. Monorepo `paperclip-plugins` com regra para separar um plugin quando fizer sentido (decisão 1). |

## Fatos do fornecedor que moldam o desenho

Verificados no Paperclip `0f14d26` (master de 2026-09-27); SDK publicado no npm como `@paperclipai/plugin-sdk@2026.916.1` (`latest` na data).

1. **Worker é um processo Node por plugin**, com ambiente mínimo: `PAPERCLIP_DEPLOYMENT_MODE/EXPOSURE`, `PATH`, `NODE_PATH`, `PAPERCLIP_PLUGIN_ID`, `NODE_ENV`, `TZ`. Não recebe `PAPERCLIP_PUBLIC_URL` nem variáveis do operador.
2. **Configuração é por empresa** (`plugin_config` com chave plugin + empresa), mesmo o campo do manifest se chamando `instanceConfigSchema` (JSON Schema). `ctx.config.get(companyId)` exige a empresa. Eventos chegam de **todas** as empresas; empresa sem configuração = plugin desligado para ela.
3. **Secrets**: campo com `"format": "secret-ref"` no schema; valor guardado como `{ type: "secret_ref", secretId }`; leitura com `ctx.secrets.resolve(ref, { companyId, configPath })` e capability `secrets.read-ref`. Limite de **30 leituras/min** por empresa e plugin.
4. **`ctx.http.fetch` bloqueia IPs privados** (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc/fd, fe80), timeout 30 s. O `fetch` global do Node funciona sem esse bloqueio.
5. **Eventos**: `ctx.events.on(tipo, [filtro], handler)`, capability `events.subscribe`. Envelope `{ eventId, eventType, occurredAt, actorId, actorType, entityId, entityType, companyId, payload }`; `payload` é `unknown`. Barramento em memória, sem persistência: evento emitido com o worker parado se perde.
6. **Entrega duplicada** ([paperclipai/paperclip#13732](https://github.com/paperclipai/paperclip/issues/13732)): cada chamada a `events.on()` cria uma assinatura no host, e o worker roda todos os handlers do tipo para cada assinatura. N registros do mesmo tipo = N×N chamadas. `eventId` é um UUID novo por emissão.
7. **`approval.decided` não traz a decisão**: aprovado, rejeitado e "revisão pedida" viram o mesmo evento. É preciso `ctx.approvals.get(id, companyId)` (capability `approvals.read`).
8. **Orçamento**: `budget.incident.opened` cobre o limite suave (80%) e o rígido (100%); `budget.incident.resolved` fecha.
9. **`issue.updated`** traz `status` e `_previous.status`. Status possíveis: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`.
10. **`agent.run.*`**: payload com `runId`, `agentId`, `status`, `error`, `errorCode`, `issueId`, `startedAt`, `finishedAt`; `agent.run.failed` cobre falha e timeout.
11. **Jobs**: `ctx.jobs.register` + `jobs[]` no manifest com cron de 5 campos; o agendador verifica a cada 30 s e não roda o mesmo job em paralelo. Sem retry automático.
12. **Estado**: `ctx.state.get/set/delete` com escopos `instance`, `company`, `project`, `agent`, `issue`, `run` etc. (capabilities `plugin.state.read/write`).
13. **UI**: o slot `companySettingsPage` (capability `instance.settings.register`) monta uma página em `/:prefixo/company/settings/:routePath` e mantém o formulário automático gerado do schema. O botão "Test configuration" do host chama `onValidateConfig` **sem empresa**, então não resolve secrets.
14. **Links**: `/{prefixo}/issues/{identificador}`, `/{prefixo}/approvals/{id}`, `/{prefixo}/agents/{agentId}/runs/{runId}`; o prefixo vem de `ctx.companies.get(companyId).issuePrefix` (`companies.read`).
15. **Testes**: `createTestHarness` do SDK (`emit`, `performAction`, `runJob`, `getState`, `logs`, `metrics`). Limitações: `http.fetch` é o `fetch` global, `secrets.resolve` devolve `"resolved:..."` e `config.get` ignora a empresa. O harness não reproduz a duplicação de eventos.

## Decisões

### 1. Monorepo de plugins, três pacotes nesta entrega

Este repositório (`rodolphobrock/paperclip-plugins`, licença MIT, igual ao Paperclip) é uma coleção de plugins para o Paperclip em pnpm workspace. Os plugins de notificação são a primeira família; plugins futuros, de notificação ou não, entram como novos pacotes em `packages/`.

```
paperclip-plugins/
├── packages/
│   ├── notify-core/     # @paperclip-plugins/notify-core (biblioteca interna, private)
│   ├── plugin-ntfy/     # paperclip-plugin-ntfy
│   └── plugin-apprise/  # paperclip-plugin-apprise
├── examples/
│   └── notify/docker-compose.yml   # ntfy + apprise-api para teste local
├── docs/specs/          # specs de design, uma por entrega
├── .changeset/
├── .github/workflows/   # ci.yml, release.yml
├── biome.json
├── tsconfig.base.json
└── pnpm-workspace.yaml
```

Convenções do repositório:

- Plugins: pasta `plugin-<nome>`, pacote npm `paperclip-plugin-<nome>` sem escopo (padrão do ecossistema), ID de manifest igual ao nome do pacote.
- Bibliotecas compartilhadas: pasta `<família>-core`, pacote `@paperclip-plugins/<família>-core` com `"private": true`. O código fica num lugar só; cada plugin a declara como `devDependency` (`workspace:*`) e o esbuild a embute no `worker.js` (a preset do SDK usa `bundle: true`), então o pacote publicado do plugin não depende dela. Só vira pacote público se houver uso fora deste repositório.
- Cada pacote tem versão, changelog e README próprios; o README da raiz é o índice.
- CI roda só os pacotes afetados (`pnpm --filter "...[origin/main]"`); labels de issue por pacote (`pkg:ntfy`, `pkg:apprise`, `pkg:notify-core`).
- Um plugin sai para repositório próprio se ganhar outro mantenedor, dependências pesadas ou for adotado pelos maintainers do Paperclip.

### 2. Biblioteca comum sem efeitos colaterais

O core não é plugin: não chama `definePlugin`/`runWorker`, não registra nada ao ser importado. Exporta uma função que o plugin chama no `setup`. No core, `@paperclipai/plugin-sdk` entra só como tipos (`import type`) e `devDependency`; nos plugins, segue o padrão dos plugins da comunidade (`peerDependency`), com o build pela preset do SDK.

Arquitetura portas e adaptadores:

```
events.on ─► EventMapper ─► Notification ─► Policy (filtros, severidade mínima)
                (puro)                          │
                                                ▼
                            Dedupe ─► QuietHours ─► RateLimiter/Digest ─► Sender
                           (state)     (relógio)        (state)         (HTTP)
                                                                          │ falha retentável
                                                                          ▼
                                                            RetryQueue (state) ◄─ job "delivery-drain"
```

Regras de código:

- Funções puras para mapeamento, formatação, severidade e horários; `ctx` só nas bordas.
- Dependências injetadas (`clock`, `fetch`, `state`, `logger`) para testar sem host.
- TypeScript `strict`, sem `any`; payloads de evento validados com guardas de tipo (payload é `unknown`).
- Módulos pequenos, um motivo para mudar cada um.

### 3. Contratos do core

```ts
type Severity = "low" | "normal" | "high" | "urgent";
type Tone = "info" | "success" | "warning" | "failure";

interface Notification {
  key: string;            // chave semântica de dedupe (ver decisão 5)
  companyId: string;
  eventType: PluginEventType;
  severity: Severity;
  tone: Tone;
  title: string;          // ≤ 120 caracteres
  body: string;           // texto; Markdown leve opcional
  url?: string;           // deep link no Paperclip
  tags: string[];         // ex.: ["approval", "agent:cto"]
  occurredAt: string;     // ISO 8601
}

type SendResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string; retryAfterMs?: number };

interface NotificationSender<C> {
  readonly name: string;
  send(n: Notification, config: C, deps: SenderDeps): Promise<SendResult>;
  sendTest(config: C, deps: SenderDeps): Promise<SendResult>;
}

interface SenderDeps {
  fetch: typeof fetch;    // ctx.http.fetch ou global, conforme allowPrivateNetwork
  resolveSecret(ref: SecretRef, configPath: string): Promise<string>;  // com cache
  logger: PluginLogger;
}

function createNotifier<C extends BaseConfig>(opts: {
  sender: NotificationSender<C>;
  parseConfig(raw: unknown): C;   // valida e aplica defaults
}): { setup(ctx: PluginContext): Promise<void> };
```

Erros HTTP: 429 e 5xx → `retryable: true` (respeita `Retry-After`); 4xx restante → `retryable: false`; erro de rede/timeout → `retryable: true`.

### 4. Catálogo de eventos (v0.1)

| Evento | Condição | Severidade | Tom | Ligado por padrão | Enriquecimento |
| --- | --- | --- | --- | --- | --- |
| `approval.created` | sempre | high | warning | sim | `approvals.get` (tipo, resumo) |
| `approval.decided` | sempre | normal | success/failure conforme status | sim | `approvals.get` (status) |
| `agent.run.failed` | sempre | high | failure | sim | `agents.get` (nome) |
| `budget.incident.opened` | limite rígido | urgent | failure | sim | — |
| `budget.incident.opened` | limite suave | high | warning | sim | — |
| `budget.incident.resolved` | sempre | normal | success | sim | — |
| `issue.updated` | `status` mudou para `blocked` | high | warning | sim | — |
| `issue.updated` | `status` mudou para `done` | normal | success | não | — |
| `issue.created` | sempre | low | info | não | — |
| `issue.comment.created` | autor não é o próprio agente responsável | low | info | não | `issues.get` |
| `agent.run.finished` | sempre | low | success | não | — |
| `agent.status_changed` | novo status `error` ou `paused` | high | warning | não | — |

Um handler por tipo de evento (decisão 5); variações de condição são tratadas dentro do mapeador. Quando o enriquecimento falha, a notificação sai com os dados do payload e o erro vai para o log (degradação, não bloqueio).

Capabilities mínimas de cada plugin: `events.subscribe`, `http.outbound`, `secrets.read-ref`, `plugin.state.read`, `plugin.state.write`, `jobs.schedule`, `companies.read`, `approvals.read`, `agents.read`, `issues.read`, `instance.settings.register`, `metrics.write`, `activity.log.write`.

### 5. Deduplicação em duas camadas

1. **Registro único**: o core registra exatamente um `events.on` por tipo de evento, o que elimina o N×N descrito no fato 6.
2. **Chave semântica** guardada em `ctx.state` (escopo `company`, namespace `notify`, chave `dedupe`): anel com as últimas 500 chaves e TTL de 10 min. A chave inclui `eventId` e também `eventType + entityId + estado relevante` (ex.: `approval.decided:<id>:approved`), porque duas escritas do log de atividade geram `eventId` diferentes para o mesmo fato.

Mesmo com a #13732 corrigida no core, a camada 2 continua útil (reinícios, eventos repetidos).

### 6. Entrega: silêncio, limite, digest e retry

- **Horário de silêncio** (por empresa, fuso IANA): notificações abaixo de `urgent` vão para o digest em vez de sair na hora; `urgent` sempre passa (configurável).
- **Limite**: token bucket por empresa (padrão 10/min). O excedente vai para o digest.
- **Digest**: fila em `ctx.state`; o job `delivery-drain` (cron `*/1 * * * *`) envia uma notificação única "N eventos desde HH:MM" com as 10 primeiras linhas e link para a caixa de entrada, respeitando a janela configurada (padrão 5 min) e o fim do silêncio.
- **Retry**: falha retentável entra na fila com backoff exponencial (30 s, 1 min, 2 min, 4 min…), até `maxAttempts` (padrão 5) ou `maxAgeMinutes` (padrão 60). Esgotado, registra em `ctx.activity.log` e na métrica `notify.dropped`.
- **Desligamento** (`onShutdown`): grava as filas pendentes; nada fica só em memória.

### 7. Configuração e 12-factor

O worker não recebe variáveis de ambiente (fato 1), então o fator III (config no ambiente) é adaptado: **a configuração vive no armazenamento do host, por empresa, e os segredos no cofre do host**. Nada de configuração no código ou no pacote.

| Fator | Como fica |
| --- | --- |
| I. Base de código | Um repositório, três pacotes; os dois plugins publicados por versão, a biblioteca embutida neles. |
| II. Dependências | Explícitas; SDK como `peerDependency`; lockfile commitado no repositório próprio. |
| III. Configuração | Schema por empresa no host; segredos por `secret-ref`. |
| IV. Serviços de apoio | ntfy e apprise-api tratados como recursos anexados por URL; trocar de servidor = trocar configuração. |
| V. Build, release, execução | Build com esbuild; release por changesets + npm com provenance; execução pelo host. |
| VI. Processos | Worker sem estado local relevante; filas e dedupe em `ctx.state`. |
| IX. Descartabilidade | Início rápido; `onShutdown` grava as filas. |
| X. Paridade dev/prod | Instalação local por caminho (`paperclipai plugin install <caminho>`) e em produção pelo npm; mesmo compose de ntfy/apprise para testes. |
| XI. Logs | `ctx.logger` como fluxo de eventos, sem gravar arquivos. |

**Campos comuns** (fragmento de schema exportado pelo core):

| Campo | Tipo | Padrão | Observação |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Empresa sem configuração salva = desligado. |
| `paperclipBaseUrl` | string (URI) | — | Necessário para deep links (fato 1). |
| `events` | objeto por tipo `{ enabled, severity? }` | tabela da decisão 4 | Permite sobrescrever severidade. |
| `minSeverity` | enum | `low` | Corte global. |
| `filters.projectIds` / `filters.agentIds` | string[] | vazio = todos | Lista de inclusão. |
| `quietHours` | `{ enabled, start, end, timezone, allowUrgent }` | desligado; `allowUrgent: true` | `start`/`end` em `HH:MM`. |
| `rateLimit` | `{ perMinute, digestWindowMinutes }` | `10`, `5` | |
| `retry` | `{ maxAttempts, maxAgeMinutes }` | `5`, `60` | |
| `network.allowPrivateNetwork` | boolean | `false` | Decisão 8. |

### 8. Rede privada

Com `allowPrivateNetwork: false`, o envio usa `ctx.http.fetch` (proteção SSRF do host). Com `true`, usa o `fetch` global, com timeout próprio de 10 s e `AbortController`. O README explica o risco: o operador declara que confia no destino. Necessário para ntfy/apprise-api self-hosted na rede interna.

### 9. Deep links

`paperclipBaseUrl` + rota da decisão (fato 14). O `issuePrefix` é lido uma vez por empresa com `ctx.companies.get` e guardado em memória por 10 min. Sem `paperclipBaseUrl`, a notificação sai sem link e o log avisa uma vez por empresa.

### 10. Página de configuração e teste

Slot `companySettingsPage` com `routePath` `ntfy` ou `apprise`. A página:

- Mostra o estado (último envio, últimos erros, tamanho das filas) via `ctx.data.register("status")`.
- Tem o botão "Enviar notificação de teste" via `ctx.actions.register("send-test")`, que resolve secrets com a empresa correta (contorna o fato 13).
- Não reimplementa o formulário: a configuração continua no formulário automático gerado do schema.

UI em React com `usePluginData`, `usePluginAction`, `usePluginToast`; bundle com `createPluginBundlerPresets` do SDK.

### 11. Plugin ntfy

Envio: `POST {serverUrl}/{topic}` com corpo em texto e headers `Title`, `Priority` (1–5), `Tags`, `Click`, `Markdown: yes` (opcional), `Icon` (opcional), `Authorization`.

| Severidade | Prioridade ntfy |
| --- | --- |
| low | 2 (low) |
| normal | 3 (default) |
| high | 4 (high) |
| urgent | 5 (max) |

| Tom | Tag ntfy (emoji) |
| --- | --- |
| info | `information_source` |
| success | `white_check_mark` |
| warning | `warning` |
| failure | `rotating_light` |

Campos próprios:

| Campo | Tipo | Padrão | Observação |
| --- | --- | --- | --- |
| `serverUrl` | URI | `https://ntfy.sh` | |
| `topic` | string | — | Obrigatório. No ntfy.sh o nome do tópico funciona como senha; o README recomenda token. |
| `topicsBySeverity` | objeto opcional | — | Ex.: `urgent` num tópico separado. |
| `auth.mode` | `none` \| `token` \| `basic` | `none` | |
| `auth.token` | secret-ref | — | Envia `Authorization: Bearer`. |
| `auth.username` / `auth.password` | string / secret-ref | — | Basic. |
| `extraHeaders` | `[{ name, value: secret-ref }]` | vazio | Ex.: `CF-Access-Client-Id` e `CF-Access-Client-Secret` para ntfy atrás do Cloudflare Access. |
| `markdown` | boolean | `false` | |
| `iconUrl` | URI | — | |

### 12. Plugin Apprise

Dois modos, escolhidos na configuração (`mode`):

| | Com estado (`stateful`) | Sem estado (`stateless`) |
| --- | --- | --- |
| Envio | `POST {apiUrl}/notify/{configKey}` com `{ title, body, type, tag, format }` | `POST {apiUrl}/notify` com `{ urls, title, body, type, format }` |
| Onde ficam os destinos e credenciais | No apprise-api (cadastrados uma vez no painel) | No Paperclip, como secrets (URLs do Apprise contêm tokens e senhas) |
| Roteamento por severidade | Por tag cadastrada no apprise-api | Por destino: cada URL tem `minSeverity` |
| Prioridade e link por evento | Não (fixos na URL cadastrada); link vai no corpo | Sim para `ntfy://`/`ntfys://` (o plugin acrescenta `priority`, `tags` e `click` à URL); demais serviços recebem o link no corpo |
| Requisito do apprise-api | Configuração salva com a chave | `APPRISE_STATELESS_MODE` não desabilitado |

Mapeamento comum aos dois modos:

| Elemento | Mapeamento |
| --- | --- |
| `type` | tom: `info`, `success`, `warning`, `failure` |
| `tag` (com estado) | `tagsBySeverity[severidade]`, padrão `low`/`normal` → `info`, `high` → `alert`, `urgent` → `urgent,alert` |
| `format` | `text` ou `markdown` |

Campos próprios:

| Campo | Tipo | Padrão | Observação |
| --- | --- | --- | --- |
| `apiUrl` | URI | — | Obrigatório. |
| `mode` | `stateful` \| `stateless` | `stateful` | Com estado é o padrão por manter credenciais fora do Paperclip. |
| `configKey` | secret-ref | — | Obrigatório com estado. A chave dá acesso à configuração, por isso é segredo. |
| `tagsBySeverity` | objeto | tabela acima | Só com estado. |
| `destinations` | `[{ url: secret-ref, minSeverity }]` | vazio | Obrigatório sem estado; ao menos um destino. |
| `format` | `text` \| `markdown` | `text` | |
| `auth` | `none` \| `basic` (+ secret-ref) | `none` | Para apprise-api com autenticação ligada. |
| `extraHeaders` | `[{ name, value: secret-ref }]` | vazio | Mesmo uso do ntfy. |

No modo sem estado, as URLs resolvidas nunca aparecem em logs, erros ou na página de status (só o esquema, como `tgram://…`).

### 13. Observabilidade

- Logs estruturados: `notify.sent`, `notify.suppressed` (motivo: filtro, dedupe, silêncio), `notify.queued`, `notify.retry`, `notify.dropped`. Nunca logar corpo de secret nem URL com credencial.
- Métricas `ctx.metrics.write`: `notify.sent`, `notify.failed`, `notify.dropped`, `notify.deduped`, `notify.digested`, com tags `eventType` e `severity`.
- `onHealth`: degradado se a última entrega falhou há menos de 5 min ou se a fila de retry passar de 100 itens.

### 14. Contribuição upstream

1. Comentar na #26 (e citar na #2897 e #3257) apontando os pacotes publicados.
2. PR no awesome-paperclip listando os dois plugins.
3. Opcional e separado: PR pequeno no core corrigindo a #13732 (uma assinatura no host por tipo de evento). Antes, conversar no Discord `#dev`, como pede o `CONTRIBUTING.md`; seguir o template de PR, título `fix(plugins): ...`, com teste.

### 15. Ferramentas, CI e publicação

- Node ≥ 24.11, pnpm 9, TypeScript `strict`, esbuild (presets do SDK), Vitest, Biome (lint e formatação).
- `ci.yml`: typecheck, lint, testes com cobertura, build, em Node 24; roda em PR e push.
- `release.yml`: changesets gera versão e changelog; publicação no npm com provenance (trusted publishing do GitHub Actions); tags `v<pacote>@<versão>`.
- `minimumHostVersion: "2026.916.1"` nos manifests.
- Desenvolvimento no Windows: definir `npm_config_script_shell` para o Git Bash (scripts do ecossistema são POSIX).

### 16. Testes

| Camada | O que cobre | Ferramenta |
| --- | --- | --- |
| Unitário (core) | mapeadores de cada evento, severidade, formatação, horário de silêncio com relógio falso, token bucket, backoff, dedupe | Vitest |
| Contrato (senders) | headers e corpo exatos do ntfy e do apprise-api; classificação de erro 4xx/429/5xx/timeout | Vitest + `fetch` injetado |
| Harness (plugins) | `emit` de eventos → chamadas de `fetch`; `performAction("send-test")`; `runJob("delivery-drain")`; estado das filas | `createTestHarness` |
| Integração | envio real para ntfy e apprise-api em containers | `examples/notify/docker-compose.yml` |
| Ponta a ponta manual | instância local do Paperclip com os plugins instalados por caminho; roteiro dos critérios de aceite | checklist no README |

Meta: cobertura ≥ 90% no core e ≥ 80% nos plugins. O teste de dedupe registra o mesmo handler duas vezes para simular a #13732, já que o harness não reproduz a duplicação.

## Fases (ordem de execução)

Entrega única (v0.1 e v0.2 juntas), feita em sequência; cada fase termina com testes verdes e commit.

| Fase | Entrega |
| --- | --- |
| 0 | Esta spec revisada e plano de implementação |
| 1 | Base do monorepo (workspace, Biome, CI, changesets) e scaffold dos pacotes |
| 2 | Core: contratos, mapeadores, política, dedupe, deep links, testes unitários |
| 3 | Plugin ntfy: sender, manifest, schema, página de teste, testes de contrato e harness |
| 4 | Core: silêncio, token bucket, digest, retry, job, observabilidade |
| 5 | Plugin Apprise (com e sem estado): sender, manifest, schema, página, testes |
| 6 | Integração com compose, ponta a ponta numa instância local e com ntfy atrás do Cloudflare Access |
| 7 | READMEs, release, PR no awesome-paperclip, comentários nas issues |

## Roadmap

### v0.3 — aprovar e rejeitar pela notificação

Botões "Aprovar" e "Rejeitar" na notificação do ntfy para `approval.created`. Base no SDK: `ctx.approvals.decide(id, { action, actorUserId }, companyId)` (capability `approvals.respond`), que valida no host se `actorUserId` é membro humano ativo da empresa, e `webhooks.receive` para o plugin receber o clique.

Precisa de desenho de segurança próprio antes de implementar:

- Token de ação de uso único, assinado (HMAC), com expiração curta e ligado a aprovação, ação e usuário; nunca reutilizável.
- Qual usuário humano é o autor da decisão (configurado por empresa) e como isso aparece na auditoria.
- Exposição do endpoint de webhook (no caso de instância atrás do Cloudflare Access, liberação só desse caminho).
- Idempotência (`applied: false` em cliques repetidos) e resposta amigável no navegador.
- Só no ntfy (ações HTTP); no Apprise não há botões.

## Critérios de aceite

1. Com o plugin ntfy configurado numa empresa, cada evento ligado por padrão (decisão 4) gera exatamente uma notificação com título, prioridade, tags e link corretos.
2. Registrando handlers duplicados (simulação da #13732), continua saindo uma notificação por fato.
3. `approval.decided` mostra aprovado, rejeitado ou revisão pedida corretamente.
4. Limite suave e rígido de orçamento saem com severidades diferentes.
5. Empresa sem configuração não recebe nada; duas empresas com tópicos diferentes recebem só os próprios eventos.
6. Horário de silêncio segura eventos abaixo de `urgent` e os entrega num digest ao fim da janela.
7. Com o servidor fora do ar, as notificações entram no retry e saem quando ele volta, dentro de `maxAgeMinutes`; passado o limite, aparecem em `notify.dropped` e no activity log.
8. "Enviar notificação de teste" funciona com token em secret e com headers do Cloudflare Access.
9. Com `allowPrivateNetwork: false`, destino em IP privado falha com mensagem clara; com `true`, funciona.
10. O plugin Apprise entrega nos dois modos: com estado, usando a tag conforme a severidade; sem estado, respeitando `minSeverity` por destino e aplicando prioridade e link de clique em destinos ntfy.
11. Nenhum log contém token, senha, `configKey` ou valor de header secreto.
12. CI verde; cobertura dentro da meta; pacotes publicados com provenance.

## Riscos e pontos em aberto

- **Eventos perdidos em reinício**: o host não persiste eventos (fato 5). Mitigação só parcial (filas persistidas depois do recebimento). Documentar no README.
- **Payloads sem tipo**: mudanças no core podem quebrar mapeadores sem aviso. Mitigação: guardas de tipo, degradação para mensagem genérica e testes com payloads reais capturados.
- **Distinguir limite suave e rígido**: os dois viram `budget.incident.opened`; confirmar na implementação qual campo do payload diferencia (provavelmente o `action` original ou um campo de limite). Se não houver, usar `costs.read` para consultar o incidente.
- **Condição de `issue.comment.created`** ("autor não é o responsável"): confirmar os campos disponíveis no payload.
- **Custo do estado**: cada evento lê e grava o anel de dedupe. Aceitável no volume esperado; revisar se passar de dezenas de eventos por minuto.
- **API do SDK instável**: o SDK segue a versão do Paperclip (calendário). Fixar `minimumHostVersion` e rodar o CI contra `latest` e `beta` do `@paperclipai/plugin-sdk`.
- **Nomes no npm**: `paperclip-plugin-ntfy` e `paperclip-plugin-apprise` estavam livres em 2026-09-27; conferir de novo antes do primeiro publish.
