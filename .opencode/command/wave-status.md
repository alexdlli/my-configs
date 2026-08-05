---
description: Estado das branches de uma onda em execução, numa tabela compacta. Só reporta — não conserta, não mergeia.
---

Onda a consultar: `$ARGUMENTS` (número da onda, ou a lista de branches/tickets).
Sem argumento, use a tabela da onda que você já tem em contexto; se não tiver
nenhuma, pergunte — não varra o repo atrás de branches parecidas.

Spawne o subagente **`wave-monitor`** passando ticket, branch e `owner/repo` de cada
linha da onda. Não rode o polling você mesmo: cada consulta traz um payload de PR
inteiro, e N branches vezes M rodadas de polling entopem a thread principal com
o que ela menos precisa guardar. O `wave-monitor` roda em `haiku`, no contexto
dele, e devolve só a tabela.

Ele usa `~/.claude/harness/scripts/waves/pr-state.mjs`, que já distingue os dois
casos que se parecem: run cancelado por force-push (`RUNNING` com
`reason: superseded-by-newer-commit` — o agente se autocorrigiu, **não é falha**)
de build vermelho de verdade.

O que ele devolve:

```text
| Ticket | Branch | CI | Blocking | Review | PR |
```

Mais, abaixo da tabela, só o que precisa de decisão: branches cujo estado não deu
para ler (e por quê), `FAIL` inconclusivo, e tickets sem push nenhum — esses são
os candidatos a agente travado ou morto.

Leia a tabela e me diga o que fazer, não faça. Especificamente:

- **Nada de merge**, nem sugestão de comando de merge. A onda seguinte espera eu
  mergear.
- **Nada de consertar** o vermelho de outro ticket entrando no worktree dele. Se
  um worker travou, a decisão de reenviar prompt, matar ou reabrir o ticket é
  minha.
- Ticket verde não fecha a onda. Onda fecha quando eu digo que fechou.
