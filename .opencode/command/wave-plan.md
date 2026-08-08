---
description: Monta o grafo de dependências de um recorte de GitHub Issues e imprime o plano de ondas.
---

Carregue a skill `wave-orchestration` antes de rodar qualquer coisa — ela é dona do formato do plano, dos destaques obrigatórios e das regras invioláveis.

Escopo: $ARGUMENTS — `owner/repo` mais o recorte (`--milestone` ou `--label`). Sem argumento, pergunte qual é; não adivinhe pelo nome do repo nem assuma o repo inteiro.

O leitor de tickets é um só, `tickets-github.mjs`, e o `graph.mjs` é agnóstico de fonte. Jira não tem leitor: lá a leitura é pelo agente `atlassian`, e não existe pipeline automatizado de ondas.

Rode os dois passos **separados**, nesta ordem, e confira o código de saída de cada um:

```bash
node ~/.claude/harness/scripts/waves/tickets-github.mjs --repo <owner>/<repo> --milestone <n> --json > /tmp/wave-tickets.json
node ~/.claude/harness/scripts/waves/graph.mjs --json < /tmp/wave-tickets.json
```

`--repo` é obrigatório e o recorte (`--milestone`, `--label`) não. Sem recorte o escopo é o repo inteiro: se o stderr avisar isso e o pedido era um milestone, **pare e confirme** antes de mostrar qualquer tabela.

Se o primeiro passo falhar, pare e me diga qual foi o motivo. O leitor separa CLI `gh` ausente (3), GitHub inalcançável ou rate limit (4), não autenticado ou sem escopo (5), repo inexistente ou issues desabilitadas (6) e erro do `gh` ou leitura truncada (7). Nunca siga para o grafo com arquivo vazio: plano de ondas vazio parecendo sucesso é o pior resultado possível — leitura legítima de zero tickets vem anunciada no stderr, e é diferente de falha.

O leitor também sai com **8**: os tickets no stdout prestam, mas há dado ruim atrás deles (marcador `<!-- blocked-by: ... -->` malformado ou labels `est:` conflitantes). Mostre as linhas `! bad data:` antes da tabela e diga que a aresta ou a estimativa que faltou não entrou no plano.

Se o `graph.mjs` sair com 3, o plano está incompleto (ciclo ou `blockedBy` apontando para id inexistente): mostre `cycles` e `badData` **antes** da tabela e diga que o plano não é executável assim.

Imprima o plano nesta tabela, traduzindo os ids com o campo `labels`:

```text
| Onda | Tickets | Desbloqueia depois |
```

Depois da tabela, três destaques — nenhum deles cabe numa célula:

- **Fan-in**: para cada ticket com `fanIn: true`, diga que ele só começa quando **todos** os bloqueadores mergearem, listando-os.
- **Bloqueados externamente**: liste fora da tabela, com o id e o status do bloqueador externo. Eles não têm onda — não os empurre para uma onda alta.
- **Fora do plano**: qualquer item de `blocked` com outra `reason`, com o `detail` que o script já produziu.

Feche com os números de `stats` e, se só existir uma onda, diga na cara que ou o projeto é plano mesmo ou os `blockedBy` não foram preenchidos.

Isto é somente leitura: não crie worktree, não spawne agente, não mova ticket, não mergeie nada.
