---
name: orca-linear
description: >-
  Stub de descoberta da CLI `orca linear` — ler, criar e triar issues do Linear
  (contexto do ticket, relações de bloqueio, status, estimativa, comentários,
  anexos de PR). Use quando o tracker da sessão for Linear: ao abrir tickets a
  partir do contrato de ticket, ao ler o issue linkado à worktree, ao mover
  status ou anexar o PR. Para Jira, use o agente `atlassian`.
---

# Orca Linear

Este arquivo é um stub de descoberta, não o guia de uso. O guia completo é servido
pelo próprio binário e fica casado com a versão instalada — mantido fora daqui de
propósito, para não divergir do `orca` que vai executar os comandos.

## Carregue o guia antes de rodar qualquer comando

```text
orca skills get orca-linear
```

## Âncoras (verificadas em `orca linear --help`)

`issue [<id>] [--current] [--relations] [--comments] [--full] [--json]`,
`list-issues`, `create`, `relation add|remove`, `status set`, `estimate set`,
`comment add`, `attach`, `project list`.

Não deduza subcomando nem flag de memória: mudam entre releases do Orca. Confirme com
`orca linear <command> --help` e prefira `--json` em chamada feita por agente.
Regras de resolução do executável (`ORCA_CLI_COMMAND`, `orca-ide` no Linux) estão na
skill `orca-cli`.
