---
name: ticket-contract
description: >-
  Contrato de ticket para trabalho executado por agente autônomo. Use ao escrever,
  revisar ou quebrar tickets, ao montar um projeto no tracker, e ao decidir se um
  ticket existente já serve como prompt de agente sem contexto implícito. Dispara
  em "criar tickets", "quebrar esse escopo", "esse ticket tá bom?", "montar o
  projeto", "transformar essa spec em tickets", "revisar o backlog antes de soltar
  os agentes". Tracker pessoal: Linear via CLI `orca linear`. Tracker de trabalho:
  Jira via agente `atlassian` (somente leitura).
---

# Contrato de ticket

## Premissa

**O ticket É o prompt.** Quem executa é um agente autônomo em contexto limpo: ele
não esteve na reunião, não leu a thread do Slack, não sabe o que "a gente já tinha
combinado". Tudo que não estiver escrito no ticket não existe.

Teste único e definitivo: *se eu colar só o corpo deste ticket numa sessão nova, o
agente entrega a coisa certa?* Um ticket como "adicionar suporte a transações
recorrentes" reprova — não diz o que é recorrência aqui, onde o código mora, o que
fica de fora, nem como saber que funcionou.

## O que já está resolvido em `to-tickets` (referencie, não reescreva)

A skill `to-tickets` (`~/.claude/skills/to-tickets/SKILL.md`) cobre a mecânica de
decomposição. Carregue-a junto e reaproveite:

| Assunto | Onde |
|---|---|
| Fatia vertical / tracer bullet (regras do que é uma fatia completa) | `to-tickets/SKILL.md:29-36` |
| Wide refactor por expand → migrate → contract | `to-tickets/SKILL.md:40` |
| Quiz ao usuário sobre granularidade e arestas de bloqueio | `to-tickets/SKILL.md:42-56` |
| Publicar em ordem de dependência e trabalhar a frontier | `to-tickets/SKILL.md:58-67` |

Este contrato cobre o que falta: **o que vai dentro de cada ticket** e **quando o
projeto está pronto para ser executado por agente**.

## Divergência deliberada: paths e snippets são obrigatórios

`to-tickets/SKILL.md:105` manda evitar file paths e code snippets no ticket, porque
"they go stale fast". **Aqui a política é a oposta e não há hesitação a resolver:**
os campos 5 e 6 deste contrato exigem detalhes técnicos, módulos, funções e arquivos
afetados.

Racional: lá o consumidor é um humano que pode abrir o ticket seis meses depois, com
o código já movido de lugar. Aqui o consumidor é um agente que executa o ticket na
mesma semana, sem memória do codebase, e cujo custo de descobrir sozinho onde mexer é
alto e propenso a erro. Path desatualizado em uma semana é barato de corrigir; agente
reimplementando no módulo errado, não.

Quando as duas skills estiverem carregadas, **este contrato vence** nesse ponto
específico. Todo o resto de `to-tickets` continua valendo.

## Os 12 campos

Todo ticket carrega os 12. Campo que não se aplica é declarado como "não se aplica" —
nunca omitido em silêncio, porque a omissão não distingue "irrelevante" de
"esquecido".

| # | Campo | O que precisa estar lá |
|---|---|---|
| 1 | Título imperativo e específico | Verbo no imperativo + objeto concreto. O título sozinho já diz o que muda no produto. |
| 2 | Problema e por que resolver | O sintoma real e o custo de não fazer. Dá ao agente critério para escolher entre dois caminhos válidos. |
| 3 | Escopo e o que está FORA | O que entra e, explicitamente, o que **não** entra — com o ticket vizinho que cobre o resto, quando existir. |
| 4 | Comportamento esperado | O fluxo do ponto de vista de quem usa: entrada, saída, estados de erro, casos de borda conhecidos. |
| 5 | Detalhes técnicos relevantes | Decisões já tomadas: contrato de API, shape de dados, biblioteca a usar, invariante a preservar. Não é implementação passo a passo. |
| 6 | Módulos, funções e arquivos afetados | Onde mexer, com `path` e símbolo. Marque o que é ponto de partida verificado vs. palpite a confirmar. |
| 7 | Acceptance criteria | Lista verificável, uma condição por item, cada uma testável sem interpretação. |
| 8 | Cenários de teste | Os casos que provam o AC: caminho feliz, borda, falha. Diz o que testar, não o arquivo de teste a criar. |
| 9 | Dependências em `blockedBy` | Só arestas reais, declaradas explicitamente. Nunca inferidas de título, numeração ou ordem de escrita. |
| 10 | Rollout e kill switch | Quando há risco: flag, plano de rollback, quem/como desliga. Ticket sem risco declara "sem rollout especial". |
| 11 | Eventos e métricas | Como se sabe, em produção, que a feature funciona — evento emitido, métrica, log estruturado. |
| 12 | i18n, LGPD e factories | Chaves de tradução, dado pessoal tocado (base legal, retenção, anonimização) e factories/fixtures a criar ou estender. |

## Bom vs ruim nos quatro campos mais errados

**1 — Título**

- Ruim: `Melhorias no fluxo de pagamento` — não diz o que muda nem onde.
- Bom: `Bloquear checkout quando o cartão salvo estiver expirado`.

**3 — Fora do escopo**

- Ruim: campo ausente. O agente decide sozinho e entrega meia feature a mais.
- Bom: `FORA: retry automático do pagamento (fica em PAY-42); notificação por e-mail; mudança na tela de gestão de cartões`.

**6 — Módulos, funções e arquivos afetados**

- Ruim: `Mexer no serviço de pagamentos`.
- Bom: `src/payments/checkout.ts → validateCard() (ponto de entrada, verificado); src/payments/types.ts → CardStatus (adicionar 'expired'); provável ajuste em src/ui/CheckoutButton.tsx (confirmar)`.

**9 — `blockedBy`**

- Ruim: `blockedBy: PAY-11` porque PAY-11 tem número menor e "parece vir antes".
- Bom: `blockedBy: PAY-11 — este ticket consome o campo CardStatus.expired que PAY-11 cria no schema`. Sem uma frase dessas, a aresta não existe.

## Regras de criação de projeto

- **Nunca existe ticket separado só para testes.** Teste é entregável do ticket que
  criou o comportamento. Um ticket "escrever testes de X" é um ticket que aceitou X
  incompleto.
- **Migration e schema ficam no mesmo ticket** que usa o schema. Migration solta
  entrega banco alterado e zero comportamento — não é fatia vertical.
- **Não existe ticket de "foundation"** cheio de funções para uso futuro. Código sem
  chamador não é revisável nem verificável. A base entra junto com o primeiro uso real.
- **Cada ticket produz UM PR revisável.** Se a entrega natural são dois PRs, são dois
  tickets.
- **Ticket acima de 5 pontos é quebrado.** Sem exceção por "é só grandinho".
- **O alvo é manter PR não-trivial abaixo de ~400 linhas.** É alvo, não trava: um
  rename mecânico pode passar disso legitimamente. Um PR de lógica que passa disso é
  sinal de ticket mal quebrado.
- **Feature arriscada já nasce com rollback e observabilidade** — campos 10 e 11
  preenchidos no ato da criação, não num ticket de follow-up que ninguém pega.

## Checagem: este ticket já é um prompt de agente?

Rode item a item. Qualquer `não` reprova o ticket — corrija antes de publicar ou de
soltar o agente.

- [ ] Os 12 campos estão presentes (ou marcados como "não se aplica").
- [ ] O título, sozinho, diz o que muda no produto.
- [ ] Existe pelo menos um item explícito FORA do escopo.
- [ ] Todo termo de domínio usado aparece definido no ticket ou é vocabulário do codebase.
- [ ] Cada acceptance criterion é verificável sem interpretação (dois revisores dariam o mesmo veredito).
- [ ] Existe pelo menos um `path` concreto no campo 6, e ele existe no repo hoje.
- [ ] Cada `blockedBy` tem uma frase dizendo **o que** este ticket consome do bloqueador.
- [ ] Nenhum `blockedBy` foi inferido de ordem, numeração ou título.
- [ ] Nada no corpo depende de contexto de conversa ("como discutimos", "o de sempre", "igual ao outro").
- [ ] A estimativa é ≤ 5 pontos.
- [ ] A entrega cabe em um PR revisável.
- [ ] Se há risco: rollout, kill switch e métrica de sucesso estão escritos.
- [ ] Se toca dado pessoal ou texto de UI: LGPD e i18n resolvidos no campo 12.

Quando um campo não puder ser preenchido com honestidade, **pergunte ao usuário**.
Ticket inventado custa mais caro que ticket atrasado.

## Adaptador de tracker

As fases seguintes do fluxo consomem tickets num formato normalizado, independente do
tracker:

```
{ id, key, title, url, estimate, status, blockedBy: [id], body }
```

- `id` — identificador interno estável do tracker.
- `key` — identificador legível (`ENG-123`).
- `blockedBy` — lista de `id` de tickets que bloqueiam este. Vazia significa
  "pode começar agora".
- `body` — o corpo com os 12 campos.

Detecte o tracker com `node ~/.claude/hooks/session-context.mjs --json` e leia
`tracker` / `trackerSource`. Nunca assuma pelo nome do repo.

**Linear (pessoal) — leitura e escrita.** Use a CLI `orca linear`. Carregue o guia
casado com o binário antes de rodar qualquer comando: `orca skills get orca-linear`
(a skill `orca-linear` deste harness é só o stub de descoberta). Não invente flag a
partir de memória.

**Jira (trabalho) — somente leitura.** Delegue ao agente `atlassian`, que é o único
com acesso ao MCP da Atlassian. No trabalho os tickets chegam prontos: o papel aqui é
ler, normalizar e **auditar contra este contrato**, apontando ao usuário quais campos
faltam. Não crie nem edite ticket no Jira por conta própria.

A assimetria é deliberada. Não trate "criar ticket" como capacidade disponível quando
o tracker é Jira.

## Autoria

Nada gerado a partir de um ticket leva assinatura de IA: commit, mensagem de PR,
título de PR, comentário em ticket ou em PR. Sem `Co-Authored-By` de qualquer
assistente, sem "Generated with", sem marca equivalente. O autor é o usuário; o
agente executa.

Isso inverte o que a skill de origem deste fluxo recomenda. A regra local vence.
