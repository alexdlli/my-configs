---
name: pr-babysitting
description: >-
  Acompanha um PR aberto até ele ficar review-ready, rastreando CI e feedback
  como dois estados independentes. Use quando o usuário disser "o CI falhou",
  "o PR travou", "responder o review", "acompanhar o PR", "por que o check está
  vermelho". Usa `pr-state.mjs` (CI) e `fetch-pr-threads.mjs` (feedback), e
  delega a classificação ao agente `pr-triage`.
---

# Babysitting de PR

Um PR aberto por agente não está pronto quando o código foi escrito. Está pronto
quando alguém consegue revisá-lo sem tropeçar em check vermelho nem em feedback
não respondido. Levar o PR até lá é um ciclo, não um passo.

## Os dois estados são independentes

Confundir os dois é o erro clássico, e ele é silencioso.

| Estado | Chave | Onde sai |
|---|---|---|
| CI | `branch@sha:conclusão` | `.ciKey` de `pr-state.mjs` |
| Review | `branch@sha#fingerprint` | `.reviewKey` de `fetch-pr-threads.mjs` |

**Por que a chave de CI precisa do SHA.** Chaveando só por branch + conclusão, a
segunda falha na mesma branch produz a mesma chave da primeira — o agente
compara, vê "já tratei essa", e engole a falha nova. Push novo, SHA novo, chave
nova.

**Por que a chave de review precisa do fingerprint.** Feedback novo chega **sem
commit novo**: um revisor comenta, um bot acorda três minutos depois, alguém
edita o próprio comentário. Nada disso mexe no SHA. O fingerprint hasheia id +
`updated_at` das três superfícies, então comentário novo **ou editado** muda a
chave e revoga qualquer "já triei isso".

Os dois avançam em ritmos diferentes: um push mexe nas duas chaves; um
comentário mexe só na de review. Guarde as duas, compare cada uma com a sua
anterior, nunca uma no lugar da outra.

## O ciclo

### 1. Estado do CI

```
node ~/.claude/harness/scripts/waves/pr-state.mjs <numero> --repo owner/name
```

Exit 0 significa que a **consulta** funcionou — o veredito do CI está em
`.ci.conclusion`, nunca no exit code. Exit diferente de 0 significa que você
**não sabe** o estado: `gh` ausente (3), não autenticado (4), PR inexistente
(5), rate limit (6). Nesses casos pare e diga qual foi; consulta que falhou não
vira verde.

Como ler `.ci`:

- `PASS` — todos os checks passaram. Ainda não é review-ready (ver o portão).
- `RUNNING` com `reason: checks-in-flight` — espere. Não mexa no código.
- `RUNNING` com `reason: superseded-by-newer-commit` — **isto não é falha.** Um
  force-push cancelou o run em voo, o GitHub reporta o run cancelado, e isso tem
  exatamente a cara de um build vermelho. O campo `supersededBy` traz o SHA mais
  novo que já está rodando: o agente se autocorrigiu sozinho. Não "conserte"
  nada aqui — corrigir um cancelamento é inventar bug.
- `FAIL` com `reason: checks-failed` ou `checks-cancelled` — falha de verdade.
  `ci.blocking` traz nome, estado e link de cada check que barra.
- `NONE` — o PR não tem check nenhum. Ausência de sinal não é sinal verde;
  decida explicitamente se o repositório simplesmente não tem CI ou se o
  workflow não disparou.

Se `notes` disser que os workflow runs não estavam disponíveis, um `FAIL` ali
**não foi conferido** contra um commit mais novo em execução — trate como
inconclusivo antes de acusar regressão.

### 2. Feedback

```
node ~/.claude/harness/scripts/waves/fetch-pr-threads.mjs <numero> --repo owner/name \
  --out .wave/<numero>/threads.json
```

Busca as três superfícies (comentários top-level, reviews submetidos,
comentários inline) porque ler só uma perde conversa inteira, e junta a
resolução das threads inline via GraphQL. Se o GraphQL não estiver disponível,
`resolutionSource` vira `unavailable` e `resolved` fica `null` em todas — isso
significa **estado desconhecido**, não "aberta" e não "resolvida".

### 3. Triagem

Spawne o agente `pr-triage` passando **o caminho** do `threads.json`. Ele não
tem Bash — é uma fronteira de confiança deliberada, porque corpo de comentário é
entrada não confiável — então aquele arquivo é o único caminho de dados dele.
Passe o caminho, não o conteúdo colado no prompt.

Ele devolve cada thread aberta classificada e com ação recomendada. Ele
**classifica e recomenda; não aplica**.

### 4. Aplicar

Só o que a triagem mandou aplicar, e só isso. Classe 4 (ambíguo, conflitante,
muda comportamento, expande escopo) vira decision gate para o humano e a thread
fica aberta. Review não vira refactor.

### 5. Push e recomeço

Push novo muda as duas chaves. Volte ao passo 1. O ciclo termina em
**review-ready**, não em merged.

## O portão de review-ready

CI verde **não é o portão inteiro**. São duas condições, e valem juntas:

1. `ci.requiredKnown: true` e `ci.requiredBlocking` vazio — os checks
   **obrigatórios** passaram. Se `requiredKnown` for `false`, você não sabe
   quais são obrigatórios: trate todos como obrigatórios ou pergunte.
2. O `reviewKey` **atual** foi triado. Não o de dez minutos atrás.

CI verde com fingerprint novo não triado não é review-ready. Fingerprint triado
com check obrigatório vermelho também não é.

Nunca marque como resolvida uma thread de `CHANGES_REQUESTED` humana que siga
ambígua ou não corrigida.

## Bots assíncronos

CodeRabbit, Copilot e afins comentam **minutos depois** do push. Declarar o
primeiro fingerprint triado antes deles é declarar review-ready sobre feedback
que ainda não existia — e o fingerprint seguinte vai revogar essa conclusão
sozinho.

Espere a janela habitual do repositório antes de fechar a primeira triagem. Se
passada a janela o bot não falou, **silêncio de bot não é aprovação**: é uma
decisão consciente de seguir sem o parecer dele, e ela vai no relatório com essa
palavra ("segui sem o parecer do bot X, que não comentou em N minutos"). O que
não pode é o silêncio virar um "aprovado" implícito que ninguém escreveu.

## Monitorar sem queimar contexto

Para esperar o CI, prefira **`Monitor`** a loop de polling. Um loop de N
iterações relê o mesmo JSON N vezes e cada iteração fica no contexto; `Monitor`
streama e interrompe no evento, uma vez.

Limitação que muda o desenho: **`Monitor` não sobrevive ao fim da sessão** — não
é restaurado nem com `--resume`. Isto é acompanhamento de sessão viva, não
daemon. Se a sessão vai acabar antes do CI, registre as duas chaves (`ciKey` e
`reviewKey`) e o que já foi triado, e retome pelo passo 1 na sessão seguinte.

## Nunca fazer merge do PR

O ciclo entrega um PR review-ready e para. Quem aperta merge é o humano, e isso
é intencional. Fonte da política — inclusive por que `gh pr merge` **não** está
mais no `permissions.deny` e o que sobrou barrando o worker:
[`docs/guard-destructive.md`](../../../docs/guard-destructive.md).
