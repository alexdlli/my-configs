// OpenCode plugin: deny destructive bash — including shell-wrapped forms.
//
// Mirrors .claude/hooks/guard-destructive.mjs. Classification lives in the
// shared lib under the harness checkout (reached via ~/.claude/harness when
// installed, or relative to this file in the checkout).
//
// permission.bash deny covers the literal form and survives --yolo. It does
// NOT unwrap `bash -c "..."`. This plugin is the layer that does.
//
// Fail-open on internal errors (except indeterminate worker context for merge).

import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const BASH_TOOLS = new Set(['bash', 'Bash']);

export default async ({ directory }) => {
  let classifierPromise = loadClassifier();

  return {
    'tool.execute.before': async (input, output) => {
      if (!BASH_TOOLS.has(input.tool)) return;

      let loaded;
      try {
        loaded = await classifierPromise;
      } catch (err) {
        console.error(
          `opencode-guard-destructive: load failed (command allowed through): ${err.message}`,
        );
        classifierPromise = loadClassifier();
        return;
      }
      if (!loaded) return;

      const { classifyCommand, denialReason, isWorkerOnlyRule } = loaded.destructive;
      const {
        CONTEXT_OTHER,
        CONTEXT_INDETERMINATE,
        detectWorkerContext,
      } = loaded.worker;

      let finding;
      try {
        finding = classifyCommand(output?.args?.command);
      } catch (err) {
        console.error(
          `opencode-guard-destructive: classify failed (command allowed through): ${err.message}`,
        );
        return;
      }
      if (!finding?.blocked) return;

      let undetermined = false;
      if (isWorkerOnlyRule(finding.rule)) {
        const context = detectWorkerContext(process.env, directory);
        if (context === CONTEXT_OTHER) return;
        undetermined = context === CONTEXT_INDETERMINATE;
      }

      throw new Error(denialReason(finding, { undetermined }));
    },
  };
};
