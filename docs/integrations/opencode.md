# OpenCode

O harness também instala uma superfície OpenCode. Não é um segundo produto: são
os mesmos agentes, skills e o mesmo invariante de merge, no formato que o
OpenCode lê.

## Onde cada coisa mora

| Artefato | No checkout | Instalado em | O OpenCode lê? |
|---|---|---|---|
| Skills | `.claude/skills/<n>/` | `~/.agents/skills/<n>` **e** `~/.claude/skills/<n>` | sim (os dois) |
| Agentes | `.opencode/agent/<n>.md` | `~/.config/opencode/agent/<n>.md` | sim |
| Comandos | `.opencode/command/<n>.md` | `~/.config/opencode/command/<n>.md` | sim |
| Plugin (guard) | `.opencode/plugin/guard-destructive.js` | `~/.config/opencode/plugin/` | sim (auto-load) |
| Config gerenciada | `.opencode/opencode.json` | merge em `~/.config/opencode/opencode.json` | sim |

**`.agents/` é só skills.** Agente, comando, plugin e config **não** são lidos de
lá — o source do OpenCode (`packages/opencode/src/skill/index.ts`) só usa
`.agents` no padrão `skills/**/SKILL.md`. Forçar o resto em `.agents/` seria
inventar um loader que não existe.

`AGENTS.md` na raiz do repo continua sendo o ponteiro deliberado para
`CLAUDE.md`. O OpenCode lê `AGENTS.md` (com fallback para `CLAUDE.md`); não há
`@import`, então o ponteiro em prosa basta.

## Invariante: merge é do humano

Duas camadas, espelhando o Claude Code:

1. **`permission.bash` deny** em `.opencode/opencode.json` — `git push --force*`
   e `git commit --no-verify*`. `deny` sobrevive a `--yolo` /
   `--dangerously-skip-permissions` (só `ask` vira `allow`). Matching usa
   `findLast`: a **última** regra que casa vence, então o catch-all `*` vem
   primeiro.
2. **Plugin `guard-destructive`** (`tool.execute.before` + `throw`) — mesma
   classificação de `.claude/hooks/lib/destructive.mjs`. Fecha o envelope
   `bash -c "…"`, pipe para shell, etc.

`gh pr merge` **não** está no deny do config (ask-then-merge): o plugin só nega
em worker de onda (marcador `.wave/worker.json`); fora disso o comando chega ao
prompt.

### O buraco medido do `permission.bash` sozinho

O OpenCode parseia o comando com tree-sitter-bash e coleta cada nó `command`.
Para `bash -c "git push --force origin x"`, o único `command` é o `bash`
externo — a string entre aspas **não** vira comando filho. O padrão coletado é
a linha inteira, que **não** casa com `git push --force*`.

Isso está codificado em `scripts/opencode-bash-c-hole.test.mjs`: o permission
layer sozinho deixa passar o wrap; o `classifyCommand` compartilhado não. O
plugin é obrigatório, não opcional. Prosa dizendo que o invariante está coberto
sem o plugin estaria mentindo.

## Autonomia no dia a dia

O config gerenciado põe `bash`/`edit`/tools de leitura em `allow` e só nega os
destrutivos. `external_directory` libera `~/.agents`, `~/.claude`,
`~/.config/opencode` e `/tmp`. Reinicie o OpenCode depois do install — config
não é hot-reload. Para uma sessão pontual sem deny a contornar: `opencode --auto`
(só transforma `ask` em `allow`; `deny` continua).

## O que não porta

| Claude Code | OpenCode |
|---|---|
| `tools:` allowlist no frontmatter | `permission:` por agente (`edit: deny`, `bash: deny`) |
| Hooks `.mjs` externos (SessionStart, PreCompact, …) | Só o que tem hook de plugin — hoje o guard. auto-update / session-context / reminder **não** portam como estão |
| Herança de permission mode da sessão | Cada agente declara o seu `permission` |

## Install

Mesmo comando do Claude Code:

```bash
node scripts/install.mjs
node scripts/install.mjs --dry-run
node scripts/install.mjs --uninstall
```

Metadata OpenCode: `~/.config/opencode/.my-configs-managed.json` (separada da do
Claude). Skills em `~/.agents/skills` usam o mesmo padrão de uma entrada por vez
e nunca sobrescrevem nome de terceiros.
