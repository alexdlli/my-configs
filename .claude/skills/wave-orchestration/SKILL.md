---
name: wave-orchestration
description: >-
  Planejamento de execução em ondas a partir do grafo de dependências de um
  projeto de tickets. Use quando o usuário pedir "plano de ondas", "quantas
  frentes dá pra tocar em paralelo", "o que dá pra começar agora", "monta o
  grafo desse projeto", ou ao orquestrar várias frentes com marcos de
  sincronização. Lê o projeto no Linear via `orca linear`, monta o grafo pelas
  relações reais de bloqueio e apresenta as ondas ao humano. Hoje é somente
  leitura: o disparo dos agentes é manual.
---

# Orquestração em ondas

Uma **onda** é o conjunto de tickets que pode ser tocado em paralelo porque
todos os bloqueadores deles já estão mergeados. O paralelismo sai do grafo de
dependências, não da vontade de ir rápido.

Esta skill cobre **planejar**. O disparo automático ainda não existe — veja
`## Dispatch` no fim.

## Pré-requisito: os tickets precisam declarar `blockedBy`

Grafo bom exige aresta explícita. A skill `ticket-contract` é dona disso (campo
9 dos 12: só aresta real, com uma frase dizendo o que este ticket consome do
bloqueador; nunca inferida de título, numeração ou ordem). Projeto sem
`blockedBy` preenchido gera uma onda 1 gigante que mente sobre o paralelismo
disponível — nesse caso, volte para `ticket-contract` antes de planejar.

**Não confunda dois artefatos de nome parecido:**

| Artefato | O que é | Quem escreve |
|---|---|---|
| Skill `ticket-contract` | Qualidade do **ticket**: os 12 campos que fazem o ticket servir como prompt de agente | O `pm`, na criação do projeto |
| Arquivo `.wave/<ticket>/contract.md` | Contrato de **interface** entre `implementer` e `tester` durante a execução de um ticket: assinaturas, tipos, erros e a lista de cenários | Os dois agentes, em paralelo, antes de escrever código |

O primeiro existe antes da onda começar; o segundo nasce dentro da execução de
um ticket. Um não substitui o outro.

## 1 — Ler o projeto e montar o grafo

Dois scripts, um pipe. Não recalcule ondas na cabeça e não reordene o resultado:
o cálculo é do `graph.mjs` e é testado.

```bash
node ~/.claude/harness/scripts/waves/tickets-linear.mjs "<projeto>" --json > /tmp/wave-tickets.json
node ~/.claude/harness/scripts/waves/graph.mjs --json < /tmp/wave-tickets.json
```

`<projeto>` é a URL ou o nome do projeto no Linear.

**Rode os dois passos separados, nunca num pipe direto.** Num pipe, o código de
saída do leitor some e um erro dele vira "plano vazio". Se o primeiro comando
falhar, pare e reporte o motivo: ele distingue CLI ausente (3), app Orca fora do
ar (4), Linear desconectado (5), projeto não encontrado ou ambíguo (6) e erro do
`orca` (7).

O `graph.mjs` sai com 3 quando o plano está **incompleto** — ciclo de
dependência ou `blockedBy` apontando para id inexistente. Nesse caso o plano
impresso não é executável: leve os itens de `cycles` e `badData` ao humano antes
de qualquer outra coisa.

O que sai do `graph.mjs --json`:

| Campo | Conteúdo |
|---|---|
| `waves[]` | `{ number, tickets[] }` — cada ticket com `blockedBy`, `waitingOn`, `fanIn`, `unblocks` |
| `done[]` | Já mergeado (onda 0). Conta como bloqueador satisfeito |
| `blocked[]` | Não agendado, com `reason` (`external`, `cycle`, `unknown-blocker`, `upstream`) e `detail` legível |
| `cycles[]` | Nós de cada ciclo detectado |
| `badData[]` | `blockedBy` apontando para id que não existe no registro |
| `externals[]` | Bloqueadores fora do projeto, com status e quem eles seguram |
| `labels` | `id` → `ENG-123`, para renderizar as listas de ids |

## 2 — Apresentar o plano ao humano

Uma tabela, nesta ordem, com os ids traduzidos por `labels`:

```text
| Onda | Tickets | Desbloqueia depois |
```

E, logo abaixo, três destaques que não podem ficar escondidos numa célula:

- **Fan-in** (`fanIn: true`): diga explicitamente que o ticket só começa quando
  **todos** os bloqueadores estiverem mergeados, listando-os.
- **Bloqueado externamente**: fora da tabela, com o id e o status do bloqueador
  externo. **Não é onda alta** — é ticket sem onda, e ele não entra em nenhuma
  linha da tabela.
- **Dado ruim** (`cycles`, `badData`): antes da tabela, porque invalida o plano.

Feche com o total de tickets, quantos foram agendados, quantos ficaram de fora e
por quê. Se o plano tiver uma única onda, diga isso na cara: ou o projeto é
mesmo plano, ou os `blockedBy` não foram preenchidos.

## Regras invioláveis

Valem desde já, antes mesmo de existir disparo automático.

1. **Merge é SEMPRE humano.** Nem branch de worker, nem PR, dentro ou fora de
   onda. O output de uma onda "pronta" é o resumo e o pedido de aprovação —
   nunca o comando de merge.
2. **Cada onda nasce de `origin/main` atualizada.** Antes de cortar qualquer
   onda dependente, `git fetch origin main`. Sem isso o worktree filho não
   enxerga o código do bloqueador que acabou de mergear, e o ticket é
   reimplementado ou quebra na integração.
3. **O paralelismo vem do grafo, não da contagem de tickets.** Dez tickets numa
   onda 1 legítima são dez frentes; dez tickets encadeados são uma. Nunca
   aumente a largura da onda "porque tem gente sobrando".
4. **Nada assinado como IA.** Commit, PR, título, corpo, comentário em ticket ou
   PR: sem `Co-Authored-By` de assistente, sem "Generated with", sem marca
   equivalente. O autor é o usuário.
5. **Uma onda só fecha quando o humano diz que fechou.** Ticket em review não é
   ticket mergeado, e a onda seguinte depende de merge, não de aprovação.

## Dispatch

O disparo automático das ondas (worktree por ticket, agente por ticket,
movimentação de status) entra na próxima fase. **Hoje o disparo é manual**: esta
skill produz o plano, e o humano escolhe o que começar. Não invente aqui um
passo de criação de worktree ou de spawn de agente.
