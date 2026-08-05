---
description: Revisão adversarial do diff — dois revisores em paralelo, com lentes distintas.
---

Use a skill `adversarial-review` para revisar o diff contra a base indicada em `$ARGUMENTS` (um commit, branch ou tag; sem argumento, use `main`).

Spawne o subagente `reviewer` duas vezes numa única mensagem, cada um com uma lente distinta, entregando a cada um **apenas** o comando de diff e o requisito original — nunca o relatório de quem escreveu o código.

Reporte na ordem da skill: achados convergentes primeiro, depois as divergências com as duas posições, e a cobertura declarada por cada lente.
