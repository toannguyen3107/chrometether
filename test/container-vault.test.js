import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ContainerVault,
  extractUrlContainerHint,
  parseSetCookieHeader
} from '../src/cdp-hub/container-vault.js';

test('parseSetCookieHeader parses RFC 6265 attributes and enforces __Host- and domain rules', () => {
  const c1 = parseSetCookieHeader(
    'sid=acc1_secret; Domain=.example.com; Path=/app; Secure; HttpOnly; SameSite=Strict; Max-Age=3600',
    'https://sub.example.com/app/login'
  );
  assert.ok(c1);
  assert.equal(c1.name, 'sid');
  assert.equal(c1.value, 'acc1_secret');
  assert.equal(c1.domain, 'example.com');
  assert.equal(c1.hostOnly, false);
  assert.equal(c1.path, '/app');
  assert.equal(c1.secure, true);
  assert.equal(c1.httpOnly, true);
  assert.equal(c1.sameSite, 'Strict');
  assert.ok(c1.expires > Date.now());

  // Cross-domain Set-Cookie must be rejected
  const cross = parseSetCookieHeader(
    'evil=1; Domain=other.com; Path=/',
    'https://example.com/'
  );
  assert.equal(cross, null);

  // __Host- cookie requires Secure, HTTPS, no Domain (hostOnly), and Path=/
  const invalidHost = parseSetCookieHeader(
    '__Host-token=abc; Domain=example.com; Path=/; Secure',
    'https://example.com/'
  );
  assert.equal(invalidHost, null);

  const validHost = parseSetCookieHeader(
    '__Host-token=abc; Path=/; Secure; HttpOnly',
    'https://example.com/'
  );
  assert.ok(validHost);
  assert.equal(validHost.hostOnly, true);
});

test('ContainerVault isolates cookies and storage between acc-1 and acc-2 on the same domain', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-vault-'));
  const vaultFile = path.join(tmpDir, 'containers.json');
  try {
    const vault = new ContainerVault({ filePath: vaultFile });
    vault.ensureContainer('acc-1', { color: 'blue' });
    vault.ensureContainer('acc-2', { color: 'orange' });

    vault.applySetCookieHeaders(
      'acc-1',
      [
        'session_id=user_one; Path=/; Secure; HttpOnly; Max-Age=3600',
        'theme=dark; Path=/; Max-Age=3600'
      ],
      'https://mail.example.com/inbox'
    );
    vault.applySetCookieHeaders(
      'acc-2',
      [
        'session_id=user_two; Path=/; Secure; HttpOnly; Max-Age=3600',
        'theme=light; Path=/; Max-Age=3600'
      ],
      'https://mail.example.com/inbox'
    );

    assert.equal(
      vault.getCookieHeaderForUrl('acc-1', 'https://mail.example.com/inbox'),
      'session_id=user_one; theme=dark'
    );
    assert.equal(
      vault.getCookieHeaderForUrl('acc-2', 'https://mail.example.com/inbox'),
      'session_id=user_two; theme=light'
    );

    // Non-HttpOnly filter for document.cookie
    const jsCookies1 = vault.getCookiesForUrl('acc-1', 'https://mail.example.com/inbox', {
      includeHttpOnly: false
    });
    assert.equal(jsCookies1.length, 1);
    assert.equal(jsCookies1[0].name, 'theme');
    assert.equal(jsCookies1[0].value, 'dark');

    // Storage isolation
    vault.setStorageItem('acc-1', 'https://mail.example.com', 'jwt', 'token-1');
    vault.setStorageItem('acc-2', 'https://mail.example.com', 'jwt', 'token-2');
    assert.deepEqual(vault.getStorageSnapshot('acc-1', 'https://mail.example.com'), {
      jwt: 'token-1'
    });
    assert.deepEqual(vault.getStorageSnapshot('acc-2', 'https://mail.example.com'), {
      jwt: 'token-2'
    });

    // Reload from disk and verify deterministic ordering & persistence
    const reloaded = new ContainerVault({ filePath: vaultFile });
    const list = reloaded.listContainers();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'acc-1');
    assert.equal(list[0].mcpIsolatedContextName, 'isolated-context-1');
    assert.equal(list[1].name, 'acc-2');
    assert.equal(list[1].mcpIsolatedContextName, 'isolated-context-2');
    assert.equal(
      reloaded.getCookieHeaderForUrl('acc-1', 'https://mail.example.com/inbox'),
      'session_id=user_one; theme=dark'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildDnrSessionRulesForTab generates Set-Cookie stripper, Cookie setter, and fail-closed block rules', () => {
  const vault = new ContainerVault({ filePath: null, autoSave: false });
  vault.ensureContainer('acc-1');
  vault.applySetCookieHeaders(
    'acc-1',
    ['auth=token_acc1; Domain=example.com; Path=/; Secure; HttpOnly; Max-Age=3600'],
    'https://example.com/login'
  );

  const rules = vault.buildDnrSessionRulesForTab('acc-1', 42);
  // Every rule MUST explicitly include main_frame in resourceTypes so Chromium DNR applies it to top-level navigations!
  for (const r of rules) {
    assert.ok(Array.isArray(r.condition.resourceTypes));
    assert.ok(r.condition.resourceTypes.includes('main_frame'));
    assert.ok(r.condition.resourceTypes.includes('xmlhttprequest'));
  }

  // Rule 1: Set-Cookie removal on responses (B1 fix)
  const stripSetCookie = rules.find(
    r => r.action?.responseHeaders?.[0]?.header === 'set-cookie'
  );
  assert.ok(stripSetCookie);
  assert.deepEqual(stripSetCookie.condition.tabIds, [42]);
  assert.equal(stripSetCookie.action.responseHeaders[0].operation, 'remove');

  // Rule 3: Domain-specific Cookie replacement on requests (B3 fix)
  const setCookieRule = rules.find(
    r =>
      r.action?.requestHeaders?.[0]?.header === 'cookie' &&
      r.action?.requestHeaders?.[0]?.operation === 'set'
  );
  assert.ok(setCookieRule);
  assert.deepEqual(setCookieRule.condition.tabIds, [42]);
  assert.deepEqual(setCookieRule.condition.requestDomains, ['example.com']);
  assert.equal(setCookieRule.action.requestHeaders[0].value, 'auth=token_acc1');

  // Fail-closed block rule when debugger detaches (H2/H3 fix)
  const blockedRules = vault.buildDnrSessionRulesForTab('acc-1', 42, {
    failClosedBlocked: true
  });
  assert.equal(blockedRules.length, 1);
  assert.equal(blockedRules[0].action.type, 'block');
  assert.deepEqual(blockedRules[0].condition.tabIds, [42]);
  assert.ok(blockedRules[0].condition.resourceTypes.includes('main_frame'));

  // Large Chrome tabIds (e.g. 486,741,406) must map to valid signed 32-bit integer rule IDs (<= 2,147,483,647)
  const highTabRules = vault.buildDnrSessionRulesForTab('acc-1', 486741406);
  for (const r of highTabRules) {
    assert.ok(Number.isInteger(r.id) && r.id > 0 && r.id <= 2147483647, `rule.id ${r.id} overflows int32`);
  }

  // Subdomain + parent-domain cookies must merge hierarchically with higher priority for more specific subdomains
  vault.applySetCookieHeaders(
    'acc-1',
    ['sub_only=1; Path=/; Secure; HttpOnly'],
    'https://www.example.com/app'
  );
  // Add a non-Secure cookie on www.example.com as well to verify Secure vs non-Secure rule splitting
  vault.applySetCookieHeaders(
    'acc-1',
    ['theme_pref=compact; Path=/'],
    'https://www.example.com/app'
  );
  const mergedRules = vault.buildDnrSessionRulesForTab('acc-1', 42);
  const parentRule = mergedRules.find(
    r => r.condition.requestDomains?.[0] === 'example.com' && r.condition.urlFilter === '|https*'
  );
  const subHttpsRule = mergedRules.find(
    r => r.condition.requestDomains?.[0] === 'www.example.com' && r.condition.urlFilter === '|https*'
  );
  const subHttpRule = mergedRules.find(
    r => r.condition.requestDomains?.[0] === 'www.example.com' && !r.condition.urlFilter
  );
  assert.ok(parentRule && subHttpsRule && subHttpRule);
  assert.ok(subHttpsRule.priority > parentRule.priority);
  assert.ok(subHttpsRule.priority > subHttpRule.priority);
  assert.equal(subHttpsRule.action.requestHeaders[0].value, 'auth=token_acc1; sub_only=1; theme_pref=compact');
  // Plain HTTP rule must NEVER leak Secure cookies (auth, sub_only)
  assert.equal(subHttpRule.action.requestHeaders[0].value, 'theme_pref=compact');

  // Init script must capture and delete window.__chrometether_vault_sync from Main World
  // and isolate IndexedDB, CacheStorage, BroadcastChannel, SharedWorker, WebLocks, OPFS, and ServiceWorker
  const initScript = vault.buildInitScript('acc-1');
  assert.ok(initScript.includes('delete window.__chrometether_vault_sync'));
  assert.ok(initScript.includes('const rawSyncBinding ='));
  assert.ok(initScript.includes('IDBFactory.prototype.open'));
  assert.ok(initScript.includes('CacheStorage.prototype.open'));
  assert.ok(initScript.includes('ContainerBroadcastChannel'));
  assert.ok(initScript.includes('ContainerSharedWorker'));
  assert.ok(initScript.includes('LockManager.prototype.request'));
  assert.ok(initScript.includes('StorageManager.prototype.getDirectory'));
  assert.ok(initScript.includes('navigator.serviceWorker.getRegistrations'));
});

test('extractUrlContainerHint extracts #tether-container and strips it cleanly', () => {
  const res = extractUrlContainerHint('https://example.com/login#tether-container=acc-1');
  assert.equal(res.containerName, 'acc-1');
  assert.equal(res.cleanUrl, 'https://example.com/login');

  const withOtherHash = extractUrlContainerHint(
    'https://example.com/app#section=settings&tether-container=acc-2'
  );
  assert.equal(withOtherHash.containerName, 'acc-2');
  assert.equal(withOtherHash.cleanUrl, 'https://example.com/app#section=settings');
});
