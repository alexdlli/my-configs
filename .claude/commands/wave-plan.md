---
description: Monta o grafo de dependências de um projeto Linear e imprime o plano de ondas.
---

Carregue a skill `wave-orchestration` antes de rodar qualquer coisa — ela é dona do formato do plano, dos destaques obrigatórios e das regras invioláveis.

Projeto: $ARGUMENTS (URL ou nome do projeto no Linear). Sem argumento, pergunte qual é — não adivinhe pelo nome do repo.

Rode os dois passos **separados**, nesta ordem, e confira o código de saída de cada um:

```bash
node ~/.claude/harness/scripts/waves/tickets-linear.mjs "$ARGUMENTS" --json > /tmp/wave-tickets.json
node ~/.claude/harness/scripts/waves/graph.mjs --json < /tmp/wave-tickets.json
```

Se o primeiro falhar, pare e me diga qual foi o motivo — ele separa CLI ausente (3), app Orca fora do ar (4), Linear desconectado (5), projeto não encontrado ou ambíguo (6) e erro do `orca` (7). Nunca siga para o grafo com arquivo vazio: plano de ondas vazio parecendo sucesso é o pior resultado possível.

Se o segundo sair com 3, o plano está incompleto (ciclo ou `blockedBy` apontando para id inexistente): mostre `cycles` e `badData` **antes** da tabela e diga que o plano não é executável assim.

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
