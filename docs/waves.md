# Waves

Fluxo de execução em ondas: um projeto é quebrado em tickets, os tickets viram prompts de
agentes autônomos, e as ondas avançam pela frontier do grafo de dependências.

Esta página cobre o **contrato de ticket** — a fundação do fluxo — e o **grafo de
dependências** que gera o plano de ondas. O disparo das ondas (worktree e agente por ticket)
ainda não existe: hoje o plano sai, e quem dispara é o humano.

## Contrato de ticket

### Premissa

O ticket **é** o prompt. Quem executa é um agente em contexto limpo: não esteve na reunião,
não leu a thread, não sabe o que já tinha sido combinado. O que não está escrito no ticket
não existe para ele.

Daí a régua: *colar só o corpo do ticket numa sessão nova precisa ser suficiente para o
agente entregar a coisa certa.* "Adicionar suporte a transações recorrentes" reprova.

### Onde mora cada peça

| Artefato | Papel |
|---|---|
| `.claude/skills/ticket-contract/SKILL.md` | Fonte da verdade: os 12 campos, as regras de criação de projeto, a checagem de prontidão, o adaptador de tracker e a regra de autoria |
| `.claude/agents/pm.md` | Agente que transforma discussão/spec em projeto + tickets. Lê o codebase para preencher os campos técnicos; nunca edita código |
| `.claude/commands/ticket-new.md` | `/ticket-new` — aciona o fluxo |
| `.claude/skills/orca-linear/SKILL.md` | Stub de descoberta da CLI `orca linear` (guia completo vem do binário) |
| `~/.claude/skills/to-tickets/SKILL.md` | Prior art externa reaproveitada para a mecânica de decomposição |

Os 12 campos e as regras não são repetidos aqui de propósito: quem edita, edita a skill.

### Os 12 campos, em uma linha

1. Título imperativo e específico. 2. Problema e por que resolver. 3. Escopo e o que está
FORA. 4. Comportamento esperado. 5. Detalhes técnicos relevantes. 6. Módulos, funções e
arquivos afetados. 7. Acceptance criteria. 8. Cenários de teste. 9. Dependências em
`blockedBy`. 10. Rollout e kill switch. 11. Eventos e métricas. 12. i18n, LGPD e factories.

### Divergência deliberada de `to-tickets`

A skill `to-tickets` desaconselha file paths e code snippets no ticket ("they go stale
fast"). Aqui eles são **obrigatórios** (campos 5 e 6). O consumidor é diferente: lá, um
humano que talvez abra o ticket seis meses depois; aqui, um agente sem memória do codebase
que executa na mesma semana. Path desatualizado é barato de corrigir; agente reimplementando
no módulo errado, não.

O resto de `to-tickets` continua valendo e é referenciado, não reescrito: fatia vertical /
tracer bullet, wide refactor por expand-migrate-contract, o quiz de granularidade ao usuário,
e a publicação em ordem de dependência trabalhando a frontier.

### Formato normalizado

As fases seguintes consomem tickets independentes de tracker:

```
{ id, key, title, url, estimate, status, blockedBy: [id], body }
```

O tracker é detectado por `node ~/.claude/hooks/session-context.mjs --json` (campos `tracker`
e `trackerSource`), nunca adivinhado pelo nome do repo. Os sinais de ambiente que alimentam
essa detecção estão em [`integrations/orca.md`](integrations/orca.md).

**Assimetria deliberada entre trackers:** Linear (pessoal) tem leitura e escrita, via CLI
`orca linear` — é onde os tickets pessoais nascem. Jira (trabalho) é **somente leitura**, via
o agente `atlassian`: lá os tickets chegam prontos, e o papel do fluxo é normalizar e auditar
contra o contrato, apontando os campos que faltam.

### Autoria

Nada gerado a partir de um ticket leva assinatura de IA — commit, PR, comentário. Sem
`Co-Authored-By`, sem "Generated with", sem marca equivalente. Isso inverte a recomendação da
skill de origem do fluxo; a regra local vence.

## Grafo de dependências e plano de ondas

### Onde mora cada peça

| Artefato | Papel |
|---|---|
| `scripts/waves/tickets-linear.mjs` | Lê um projeto do Linear via CLI `orca linear` e emite o formato normalizado. Somente leitura |
| `scripts/waves/graph.mjs` | `planWaves()` — função pura que transforma tickets em ondas. Traz um wrapper stdin/stdout para o pipeline |
| `.claude/skills/wave-orchestration/SKILL.md` | Como montar o grafo, como apresentar o plano e as regras invioláveis da onda |
| `.claude/commands/wave-plan.md` | `/wave-plan` — roda o pipeline e imprime a tabela de ondas |

### Duas extensões do formato normalizado

Além dos oito campos já descritos acima, o leitor emite dois campos que o grafo precisa:

- `statusType` — o `type` do estado no tracker (Linear usa `completed`). É o sinal confiável de
  "mergeado"; o nome do estado é livre e varia por time.
- `external` — `true` quando o ticket não pertence ao projeto e só está no registro porque
  alguém depende dele.

### Como o grafo decide a onda

- Nós são tickets, arestas são `blockedBy`. `onda(t) = max(onda dos bloqueadores) + 1`; sem
  bloqueador aberto, onda 1.
- Ticket já mergeado (`statusType: completed`, ou status `done`/`merged`/`completed`) é **onda
  0** e satisfaz quem depende dele.
- **Bloqueador externo ainda aberto: o dependente não recebe onda.** Ele sai em `blocked` com
  `reason: external` e o detalhe `blocked externally by <ID> (<status>)`. Isso não é "onda
  alta" — é ticket que não entra no plano. Quem depende desse dependente também fica de fora,
  com `reason: upstream` e a causa raiz preservada.
- Externo cujo status não pôde ser lido conta como **aberto**. O leitor avisa no stderr e
  mantém o id no registro.
- **Fan-in** (2+ bloqueadores) vem marcado com `fanIn: true` e a lista `waitingOn`: o ticket só
  começa quando todos mergearem.
- **Ciclo** é detectado (Tarjan iterativo, sem recursão) e reportado com os nós envolvidos; os
  nós do ciclo não recebem onda.
- **`blockedBy` apontando para id inexistente** sai em `badData` e o ticket não é agendado.
  Ignorar em silêncio produziria uma onda 1 falsa.
- A ordem de entrada não muda o resultado: ids são ordenados por `key` (comparação numérica,
  `ENG-2` antes de `ENG-10`) antes de qualquer cálculo.

### Pipeline

```bash
node ~/.claude/harness/scripts/waves/tickets-linear.mjs "<projeto>" --json > /tmp/wave-tickets.json
node ~/.claude/harness/scripts/waves/graph.mjs --json < /tmp/wave-tickets.json
```

**Os dois passos são separados de propósito.** Num pipe direto, o código de saída do leitor
some e uma falha dele chega ao planejador como entrada vazia — o modo de falha que faz um plano
de ondas mentir. O `graph.mjs` recusa stdin vazia em vez de imprimir um plano de zero ondas.

### Falha honesta

`tickets-linear.mjs` nunca emite array vazio como sucesso. Códigos de saída:

| Código | Situação |
|---|---|
| 2 | Uso errado (sem projeto, flag desconhecida) |
| 3 | CLI `orca` não encontrada (respeita `ORCA_CLI_COMMAND`) |
| 4 | App Orca fora do ar ou runtime inalcançável |
| 5 | Orca rodando, mas Linear não conectado |
| 6 | Projeto não encontrado, ou o texto casa com mais de um |
| 7 | Erro do `orca` (código e mensagem do envelope repassados) |

Também falha, em vez de truncar, quando o Linear devolve leitura parcial, `workspaceErrors`, ou
mais páginas de issues do que o cursor consegue percorrer.

`graph.mjs` sai com 2 para entrada inutilizável e com **3 quando o plano está incompleto**
(ciclo ou id inexistente) — o plano é impresso, mas não é executável.

### Testes

`node --test <diretório>` não funciona no Node instalado (24.15): o diretório é resolvido como
módulo e o runner nem chega a rodar. Passe os arquivos:

```bash
node --test scripts/waves/graph.test.mjs scripts/waves/tickets-linear.test.mjs
```

O grafo é coberto por fixtures — caminho simples, fan-in, ciclo de 2 e de 3 nós, auto-bloqueio,
bloqueador inexistente, externo aberto, externo já mergeado, órfão, conjunto vazio e
determinismo com a entrada embaralhada.
