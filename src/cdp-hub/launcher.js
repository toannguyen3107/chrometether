import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HUB_VERSION,
  getHubHttpUrl,
  getHubPort,
  getHubWsUrl,
  getOrCreateHubToken
} from './token.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Perform an HTTP JSON request to the Local CDP Hub.
 */
export function hubHttpRequest(
  pathname,
  {
    method = 'GET',
    body = null,
    port = getHubPort(),
    token = getOrCreateHubToken(),
    timeoutMs = 2000
  } = {}
) {
  return new Promise((resolve, reject) => {
    const payload = body !== null ? JSON.stringify(body) : null;
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers,
        timeout: timeoutMs
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            resolve({ statusCode: res.statusCode, data: parsed });
          } catch {
            resolve({ statusCode: res.statusCode, data: null, raw });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Hub HTTP request ${method} ${pathname} timed out`));
    });
    req.on('error', reject);

    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Query `/health` on the Local Hub. Returns the health object or `null` if unreachable.
 */
export async function checkHubHealth({ port = getHubPort(), timeoutMs = 1000 } = {}) {
  try {
    const res = await hubHttpRequest('/health', { port, timeoutMs });
    if (res.statusCode === 200 && res.data && res.data.ok) {
      return res.data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Stop a running Hub daemon if active.
 */
export async function stopHubDaemon({ port = getHubPort(), token = getOrCreateHubToken() } = {}) {
  try {
    const health = await checkHubHealth({ port, timeoutMs: 800 });
    if (!health) return { stopped: false, reason: 'not_running' };
    await hubHttpRequest('/shutdown', { method: 'POST', port, token, timeoutMs: 1500 });
    return { stopped: true };
  } catch {
    return { stopped: false, reason: 'error' };
  }
}

/**
 * Ensure the background Hub daemon is running and matches `HUB_VERSION`.
 * Never writes to stdout so MCP stdio streams remain uncorrupted (Fable M4).
 */
export async function ensureHubDaemon({
  port = getHubPort(),
  token = getOrCreateHubToken(),
  waitTimeoutMs = 4500
} = {}) {
  const existing = await checkHubHealth({ port, timeoutMs: 800 });
  if (existing && existing.version === HUB_VERSION) {
    return existing;
  }

  if (existing && existing.version && existing.version !== HUB_VERSION) {
    await stopHubDaemon({ port, token });
    await new Promise(r => setTimeout(r, 200));
  }

  const serverScript = path.join(__dirname, 'server.js');
  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      CHROMETETHER_HUB_PORT: String(port),
      CHROMETETHER_HUB_TOKEN: token
    }
  });
  child.unref();

  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const health = await checkHubHealth({ port, timeoutMs: 500 });
    if (health && health.ok) {
      return health;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  throw new Error(
    `ChromeTether CDP Hub failed to become ready on ${getHubHttpUrl(port)} within ${waitTimeoutMs}ms`
  );
}

/**
 * Build the CLI arguments to pass to `chrome-devtools-mcp` when connecting through the Hub.
 */
export function buildMcpHubArgs({
  port = getHubPort(),
  token = getOrCreateHubToken(),
  extraArgs = []
} = {}) {
  const filtered = extraArgs.filter(
    arg =>
      arg !== '--auto-connect' &&
      !String(arg).startsWith('--ws-endpoint') &&
      !String(arg).startsWith('--ws-headers') &&
      !String(arg).startsWith('--browser-url')
  );
  const wsEndpoint = getHubWsUrl(port);
  const wsHeaders = JSON.stringify({ Authorization: `Bearer ${token}` });
  return [`--ws-endpoint=${wsEndpoint}`, `--ws-headers=${wsHeaders}`, ...filtered];
}

/**
 * Resolve bundled `chrome-devtools-mcp.js` entry point.
 */
export function resolveBundledDevToolsMcpScript(projectDir = PROJECT_ROOT) {
  const candidates = [
    path.join(
      projectDir,
      'node_modules',
      'chrome-devtools-mcp',
      'build',
      'src',
      'bin',
      'chrome-devtools-mcp.js'
    ),
    path.join(
      PROJECT_ROOT,
      'node_modules',
      'chrome-devtools-mcp',
      'build',
      'src',
      'bin',
      'chrome-devtools-mcp.js'
    )
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Launch `chrome-devtools-mcp` connected to the Local Hub over stdio.
 */
export async function runLauncher(userArgs = process.argv.slice(2)) {
  const port = getHubPort();
  const token = getOrCreateHubToken();

  await ensureHubDaemon({ port, token });

  const mcpArgs = buildMcpHubArgs({ port, token, extraArgs: userArgs });
  const scriptPath = resolveBundledDevToolsMcpScript();

  const cmd = scriptPath ? process.execPath : 'npx';
  const finalArgs = scriptPath
    ? [scriptPath, ...mcpArgs]
    : ['-y', 'chrome-devtools-mcp@1.9.0', ...mcpArgs];

  const child = spawn(cmd, finalArgs, {
    stdio: 'inherit',
    windowsHide: true,
    env: process.env
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  child.on('error', err => {
    process.stderr.write(`ChromeTether launcher error: ${err.message}\n`);
    process.exit(1);
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  runLauncher().catch(err => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
