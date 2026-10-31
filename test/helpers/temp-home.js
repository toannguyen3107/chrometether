import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function withTempHome(layout = {}, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-home-'));
  const prevHome = process.env.CHROMETETHER_HOME;
  process.env.CHROMETETHER_HOME = home;

  try {
    for (const [relPath, content] of Object.entries(layout)) {
      const target = path.join(home, relPath);
      if (content === null) {
        fs.mkdirSync(target, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
      }
    }
    return await fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.CHROMETETHER_HOME;
    } else {
      process.env.CHROMETETHER_HOME = prevHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
