#!/usr/bin/env node
// claude-openai-shim — a tiny OpenAI-compatible HTTP server backed by the
// locally installed, subscription-authenticated `claude` CLI (`claude -p`).
//
// Why: ai-memory has no "claude CLI" provider — only `anthropic` (paid API key)
// and `anthropic-oauth` (raw OAuth token spoofed against /v1/messages, which is
// unofficial/against ToS). This shim lets ai-memory's `openai-compat` provider
// reach your Claude *subscription* through the SANCTIONED path: it shells out to
// `claude -p`, which Anthropic documents as drawing from your subscription's
// usage limits (support.claude.com article 15036540, as of 2026-06-15). Same
// idea as the "claude CLI" backend in ghprai, exposed as /v1/chat/completions.
//
// It deliberately strips ANTHROPIC_API_KEY from the child env so `claude` uses
// the subscription, not pay-as-you-go API billing.
//
// Endpoints:
//   POST /v1/chat/completions   (non-streaming; the shape ai-memory needs)
//   GET  /v1/models
//   GET  /healthz
//
// Env:
//   SHIM_PORT        listen port            (default 8787)
//   SHIM_HOST        bind address           (default 127.0.0.1)
//   CLAUDE_BIN       claude binary           (default "claude")
//   SHIM_MODEL       default model           (default "claude-haiku-4-5")
//   SHIM_TIMEOUT_MS  per-call timeout        (default 120000)
//   SHIM_DEBUG       set to log requests
//
// Zero dependencies (Node stdlib only). Node 20+.

import http from 'node:http';
import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = Number(process.env.SHIM_PORT || 8787);
const HOST = process.env.SHIM_HOST || '127.0.0.1';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = process.env.SHIM_MODEL || 'claude-haiku-4-5';
const TIMEOUT_MS = Number(process.env.SHIM_TIMEOUT_MS || 120000);
const DEBUG = !!process.env.SHIM_DEBUG;

const EXIT_LISTEN_FAILED = 1;
const MAX_BODY_BYTES = 50 * 1024 * 1024;

function log(...a) {
  if (DEBUG) console.error('[shim]', ...a);
}

// Flatten OpenAI chat messages into a single prompt fed to `claude -p` on stdin.
// System messages are surfaced as a labelled block so behaviour instructions
// survive; everything goes through stdin to avoid argv length limits.
function buildPrompt(messages) {
  const sys = [];
  const convo = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const content =
      typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.map((p) => p?.text ?? '').join('')
          : '';
    if (m?.role === 'system') sys.push(content);
    else if (m?.role === 'assistant') convo.push(`Assistant: ${content}`);
    else convo.push(`User: ${content}`);
  }
  const head = sys.length ? `[System instructions]\n${sys.join('\n\n')}\n\n` : '';
  return `${head}${convo.join('\n\n')}`.trim();
}

// Run `claude -p` once, return the assistant text. Strips ANTHROPIC_API_KEY so
// the subscription is used. --max-turns 1 + no tools keeps it a pure completion.
function callClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // force subscription auth, not API billing
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', model || DEFAULT_MODEL,
      '--max-turns', '1',
      '--allowedTools', '',
    ];
    log('spawn', CLAUDE_BIN, args.join(' '));
    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error(`failed to spawn ${CLAUDE_BIN}: ${e.message}`));
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`claude spawn error: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${err.trim() || out.trim()}`));
        return;
      }
      resolve(extractText(out));
    });
    child.stdin.end(prompt);
  });
}

// `claude -p --output-format json` prints an envelope:
//   {"type":"result","subtype":"success","is_error":false,"result":"...", ...}
// Fall back to raw stdout if the shape ever changes.
function extractText(stdout) {
  const trimmed = (stdout || '').trim();
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj.result === 'string') return obj.result;
    if (typeof obj?.content === 'string') return obj.content;
    if (Array.isArray(obj?.content)) {
      return obj.content.map((p) => p?.text ?? '').join('');
    }
  } catch {
    // not JSON — return as-is
  }
  return trimmed;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function oaiError(res, status, message) {
  send(res, status, { error: { message, type: 'shim_error', code: status } });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let overflowed = false;
    req.on('data', (c) => {
      if (overflowed) return;
      data += c;
      if (data.length > MAX_BODY_BYTES) {
        overflowed = true;
        // Stop buffering but leave the socket alive, so the caller's 413 has a
        // chance to reach the client instead of a bare connection reset.
        req.pause();
        reject(httpError(413, 'request body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const url = req.url || '';
  if (req.method === 'GET' && (url === '/healthz' || url === '/')) {
    send(res, 200, { ok: true, backend: CLAUDE_BIN, model: DEFAULT_MODEL });
    return;
  }
  if (req.method === 'GET' && url.startsWith('/v1/models')) {
    send(res, 200, {
      object: 'list',
      data: [{ id: DEFAULT_MODEL, object: 'model', owned_by: 'anthropic' }],
    });
    return;
  }
  if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
      // A rejected read already knows its status; only a parse error is a 400.
      oaiError(res, e.status ?? 400, e.status ? e.message : 'invalid JSON body');
      return;
    }
    const model = payload.model || DEFAULT_MODEL;
    const prompt = buildPrompt(payload.messages);
    if (!prompt) {
      oaiError(res, 400, 'no usable messages in request');
      return;
    }
    try {
      const content = await callClaude(prompt, model);
      send(res, 200, {
        id: `chatcmpl-shim-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (e) {
      log('error', e.message);
      oaiError(res, 502, `claude backend failed: ${e.message}`);
    }
    return;
  }
  oaiError(res, 404, `no route for ${req.method} ${url}`);
}

// An unhandled rejection in the request handler would take the whole process
// down, and launchd would silently restart it — answer the request instead.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    log('unhandled', e);
    if (res.headersSent) res.destroy();
    else oaiError(res, 500, `shim internal error: ${e.message}`);
  });
});

// KeepAlive=true in the LaunchAgent turns an uncaught listen error into a
// restart loop whose only trace is a stack in shim.err.log.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `claude-openai-shim: ${HOST}:${PORT} is already in use — another shim ` +
        'is running (launchctl list | grep claude-openai-shim), or set SHIM_PORT.',
    );
  } else {
    console.error(`claude-openai-shim: cannot listen on ${HOST}:${PORT}: ${e.message}`);
  }
  process.exit(EXIT_LISTEN_FAILED);
});

server.listen(PORT, HOST, () => {
  console.error(
    `claude-openai-shim listening on http://${HOST}:${PORT}  ` +
      `(backend: ${CLAUDE_BIN}, default model: ${DEFAULT_MODEL})`,
  );
});
