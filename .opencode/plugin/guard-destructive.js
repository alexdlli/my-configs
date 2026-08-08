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
//
// `git merge` is the one command an agent decides alone, and only when it
// lands on a control branch (integration/*, wave/*); protected destinations
// (main, master, prod, staging) are denied here by name. Deliberately absent
// from permission.bash: an entry there would prompt on control branches too,
// and a plugin can deny but never grant, so the autonomy has to come from the
// permission layer staying quiet.

import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASH_TOOLS = new Set(['bash', 'Bash']);

// Last-resort pattern when the shared classifier cannot load. Intentionally
// coarse: false positives cost a blocked command; silent pass costs a merge.
// `git merge` is in here too — without the lib there is no way to read the
// destination branch, and an unverifiable merge is the case this refuses.
const DESTRUCTIVE_LOOKALIKE =
  /\bgh\b[\s\S]*\bpr\b[\s\S]*\bmerge\b|\bgit\b[\s\S]*\bpush\b[\s\S]*(\s-f\b|\s--force\b)|\bgit\b[\s\S]*\bcommit\b[\s\S]*(\s-n\b|\s--no-verify\b)|\bgit\b[\s\S]*\bmerge\b/;

// Every module loadClassifier imports. Probing for only one of them let a
// candidate win the search and then fail the import: an installed harness older
// than this plugin has destructive.mjs but not the newest module beside it, and
// the whole classifier fell back to refusing anything destructive-looking. A
// candidate now has to carry all of it to be chosen, so an older installed
// harness is skipped in favour of the checkout instead of poisoning the load.
const REQUIRED_LIB_MODULES = ['destructive.mjs', 'worker-context.mjs', 'merge-destination.mjs'];

function resolveLibDir() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'harness', '.claude', 'hooks', 'lib'),
    path.resolve(__dirname, '..', '..', '.claude', 'hooks', 'lib'),
  ];
  for (const dir of candidates) {
    if (REQUIRED_LIB_MODULES.every((name) => existsSync(path.join(dir, name)))) return dir;
  }
  return null;
}

async function loadClassifier() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const destructive = await import(pathToFileURL(path.join(dir, 'destructive.mjs')).href);
  const worker = await import(pathToFileURL(path.join(dir, 'worker-context.mjs')).href);
  const merge = await import(pathToFileURL(path.join(dir, 'merge-destination.mjs')).href);
  return { destructive, worker, merge };
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

      const {
        classifyCommand,
        denialReason,
        isBranchScopedRule,
        isWorkerOnlyRule,
      } = loaded.destructive;
      const {
        CONTEXT_OTHER,
        CONTEXT_INDETERMINATE,
        detectWorkerContext,
      } = loaded.worker;
      const {
        DESTINATION_CONTROL,
        DESTINATION_INDETERMINATE,
        DESTINATION_OTHER,
        classifyMergeDestination,
      } = loaded.merge;

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

      let destination;
      if (isBranchScopedRule(finding.rule)) {
        if (finding.redirected) {
          destination = 'redirected';
        } else {
          // A plugin can only deny or step aside — it cannot grant. Stepping
          // aside IS the grant here, because permission.bash carries no
          // `git merge` entry and `"*": "allow"` covers it. Adding one would
          // prompt on control branches too and undo the autonomy.
          const landing = classifyMergeDestination(process.env, directory);
          if (landing === DESTINATION_CONTROL || landing === DESTINATION_OTHER) return;
          if (landing === DESTINATION_INDETERMINATE) destination = 'indeterminate';
        }
      }

      throw new Error(denialReason(finding, { undetermined, destination }));
    },
  };
};
