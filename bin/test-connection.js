import { spawn } from 'child_process';
import path from 'path';
import { fetchMarkdown } from '../src/reader-server/fetch-markdown.js';
import { searchDDG } from '../src/reader-server/search-ddg.js';

function testMcpServer(command, args, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    console.log(`[MCP Test] Testing ${label}...`);
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let isDone = false;

    const timer = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        proc.kill();
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${label}`));
      }
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line.trim());
          if (json.id === 1 && json.result) {
            isDone = true;
            clearTimeout(timer);
            proc.kill();
            resolve({ success: true, result: json.result });
            return;
          }
        } catch {
          // not a full json line yet
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
    });

    proc.on('error', (err) => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    // Send standard MCP JSON-RPC initialize request
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'chrometether-test-client',
          version: '1.0.0'
        }
      }
    }) + '\n';

    proc.stdin.write(initRequest);
  });
}

async function runHealthCheck() {
  console.log('====================================================');
  console.log('      CHROMETETHER DIAGNOSTICS & HEALTH CHECK       ');
  console.log('====================================================\n');

  let allPassed = true;

  // 1. Test Tier 1 Reader Engine
  console.log('--- Checking Tier 1: Fast Reader Engine ---');
  try {
    const page = await fetchMarkdown('https://example.com');
    console.log(`✔ fetchMarkdown: OK (Fetched "${page.title}")`);
  } catch (err) {
    allPassed = false;
    console.error(`❌ fetchMarkdown: FAILED (${err.message})`);
  }

  try {
    const results = await searchDDG('github', 2);
    console.log(`✔ searchDDG: OK (Found ${results.length} items)`);
  } catch (err) {
    allPassed = false;
    console.error(`❌ searchDDG: FAILED (${err.message})`);
  }

  // 2. Test Tier 1 MCP Stdio Transport
  console.log('\n--- Checking Tier 1 MCP Stdio Server ---');
  try {
    const readerScript = path.resolve('src/reader-server/index.js');
    const res = await testMcpServer('node', [readerScript], 'tether-reader MCP');
    console.log(`✔ tether-reader Stdio MCP: OK (Protocol ${res.result.protocolVersion || 'v1'})`);
  } catch (err) {
    allPassed = false;
    console.error(`❌ tether-reader MCP: FAILED (${err.message})`);
  }

  // 3. Test Tier 2 Chrome DevTools MCP Stdio Transport
  console.log('\n--- Checking Tier 2 Chrome DevTools MCP Engine ---');
  try {
    const devToolsScript = path.resolve('node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js');
    const res = await testMcpServer('node', [devToolsScript, '--headless=true'], 'chrome-devtools-mcp');
    console.log(`✔ chrome-devtools-mcp Stdio: OK (Protocol ${res.result.protocolVersion || 'v1'})`);
  } catch (err) {
    allPassed = false;
    console.error(`❌ chrome-devtools-mcp: FAILED (${err.message})`);
  }

  console.log('\n====================================================');
  if (allPassed) {
    console.log('🎉 ALL HEALTH CHECKS PASSED! The toolkit is ready to use.');
  } else {
    console.log('⚠️ Some checks failed. Please check your environment or network.');
  }
  console.log('====================================================\n');
}

runHealthCheck();
