import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_HUB_PORT = 19222;
export const HUB_VERSION = '2.0.0';

export function getHubPort() {
  const raw = process.env.CHROMETETHER_HUB_PORT;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return DEFAULT_HUB_PORT;
}

export function getHubTokenFilePath() {
  if (process.env.CHROMETETHER_HUB_TOKEN_FILE) {
    return path.resolve(process.env.CHROMETETHER_HUB_TOKEN_FILE);
  }
  const home = process.env.CHROMETETHER_HOME || os.homedir();
  return path.join(home, '.chrometether', 'hub-token');
}

export function getOrCreateHubToken({ tokenFilePath = getHubTokenFilePath() } = {}) {
  if (process.env.CHROMETETHER_HUB_TOKEN && process.env.CHROMETETHER_HUB_TOKEN.trim()) {
    return process.env.CHROMETETHER_HUB_TOKEN.trim();
  }

  try {
    if (fs.existsSync(tokenFilePath)) {
      const existing = fs.readFileSync(tokenFilePath, 'utf8').trim();
      if (existing.length >= 16) {
        return existing;
      }
    }
  } catch {
    // regenerate below
  }

  const token = crypto.randomBytes(24).toString('hex');
  try {
    const dir = path.dirname(tokenFilePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${tokenFilePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, tokenFilePath);
  } catch {
    // In read-only environments fall back to in-memory token
  }
  return token;
}

export function getHubWsUrl(port = getHubPort()) {
  return `ws://127.0.0.1:${port}/cdp`;
}

export function getHubHttpUrl(port = getHubPort()) {
  return `http://127.0.0.1:${port}`;
}
