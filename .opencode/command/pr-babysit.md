---
description: Acompanha um PR até ficar review-ready — CI e feedback rastreados como dois estados independentes.
---

Use a skill `pr-babysitting` para acompanhar o PR indicado em `$ARGUMENTS`
(número, URL ou branch; sem argumento, o PR da branch atual).

Estado do CI:

```
node ~/.claude/harness/scripts/waves/pr-state.mjs $ARGUMENTS
```

Feedback das três superfícies mais o fingerprint:

```
node ~/.claude/harness/scripts/waves/fetch-pr-threads.mjs $ARGUMENTS --out .wave/pr/threads.json
```

Depois spawne o subagente `pr-triage` passando o **caminho** do `threads.json` — ele
não tem Bash e esse arquivo é o único caminho de dados dele.

Lembretes que a skill detalha: `RUNNING` com `reason: superseded-by-newer-commit`
é force-push, não falha; review-ready exige checks obrigatórios verdes **e** o
fingerprint atual triado; espere os bots assíncronos antes de fechar a primeira
triagem; e nunca faça merge.
