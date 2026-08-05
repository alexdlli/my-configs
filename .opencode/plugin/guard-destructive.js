// OpenCode plugin: deny destructive bash — including shell-wrapped forms.
//
// Mirrors .claude/hooks/guard-destructive.mjs. Classification lives in the
// shared lib under the harness checkout (reached via ~/.claude/harness when
// installed, or relative to this file in the checkout).
//
// permission.bash covers the literal form (deny for force/no-verify, ask for
// gh pr merge) and survives --yolo. It does NOT unwrap `bash -c "..."`. This
// plugin is the layer that does for force/no-verify always, and for merge
// only in a wave worker. Non-worker merge falls through to permission.ask —
// which is the OpenCode port of Claude Code's ask-then-merge (there the
// fall-through default is ask; here bash "*" is allow, so merge must be ask).

import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASH_TOOLS = new Set(['bash', 'Bash']);

// Last-resort pattern when the shared classifier cannot load. Intentionally
// coarse: false positives cost a blocked command; silent pass costs a merge.
const DESTRUCTIVE_LOOKALIKE =
  /\bgh\b[\s\S]*\bpr\b[\s\S]*\bmerge\b|\bgit\b[\s\S]*\bpush\b[\s\S]*(\s-f\b|\s--force\b)|\bgit\b[\s\S]*\bcommit\b[\s\S]*(\s-n\b|\s--no-verify\b)/;

function resolveLibDir() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'harness', '.claude', 'hooks', 'lib'),
    path.resolve(__dirname, '..', '..', '.claude', 'hooks', 'lib'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'destructive.mjs'))) return dir;
  }
  return null;
}

async function loadClassifier() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const destructive = await import(pathToFileURL(path.join(dir, 'destructive.mjs')).href);
  const worker = await import(pathToFileURL(path.join(dir, 'worker-context.mjs')).href);
  return { destructive, worker };
}

function refuseUnavailable(command) {
  const text = typeof command === 'string' ? command : '';
  if (!DESTRUCTIVE_LOOKALIKE.test(text)) return;
  throw new Error(
    'guard-destructive: classifier unavailable; refusing a destructive-looking bash command',
  );
}

export default async ({ directory }) => {
  let classifierPromise = loadClassifier();

  return {
    'tool.execute.before': async (input, output) => {
      if (!BASH_TOOLS.has(input.tool)) return;
      const command = output?.args?.command;

      let loaded;
      try {
        loaded = await classifierPromise;
      } catch (err) {
        console.error(`opencode-guard-destructive: load failed: ${err.message}`);
        classifierPromise = loadClassifier();
        refuseUnavailable(command);
        return;
      }
      if (!loaded) {
        console.error(
          'opencode-guard-destructive: classifier not found under ~/.claude/harness or checkout',
        );
        refuseUnavailable(command);
        return;
      }

      const { classifyCommand, denialReason, isWorkerOnlyRule } = loaded.destructive;
      const {
        CONTEXT_OTHER,
        CONTEXT_INDETERMINATE,
        detectWorkerContext,
      } = loaded.worker;

      let finding;
      try {
        finding = classifyCommand(command);
      } catch (err) {
        console.error(`opencode-guard-destructive: classify failed: ${err.message}`);
        refuseUnavailable(command);
        return;
      }
      if (!finding?.blocked) return;

      let undetermined = false;
      if (isWorkerOnlyRule(finding.rule)) {
        // Non-worker merge: stay silent so permission.bash "gh pr merge*": "ask"
        // can prompt. That ask entry is what makes silence safe under bash "*": allow.
        const context = detectWorkerContext(process.env, directory);
        if (context === CONTEXT_OTHER) return;
        undetermined = context === CONTEXT_INDETERMINATE;
      }

      throw new Error(denialReason(finding, { undetermined }));
    },
  };
};
