import fs from 'fs';
import path from 'path';
import os from 'os';
import { mergeMcpConfig, getBrowserMcpConfigs } from '../src/installer/config-merger.js';
import { detectAgents } from '../src/installer/agent-detector.js';

function runMergerTest() {
  console.log('=== Testing Config Merger & Agent Detector ===\n');

  // Test 1: Agent Detection
  console.log('1. Detecting installed agents on this machine...');
  const agents = detectAgents();
  agents.forEach(a => {
    const status = a.isDetected ? (a.isConfigured ? '✔ (Configured)' : '✔ (Detected)') : '○ (Not detected)';
    console.log(`   - ${a.name}: ${status}`);
  });
  console.log('✔ Agent detection completed successfully.\n');

  // Test 2: Safe Merge with existing servers
  console.log('2. Testing safe JSON merge...');
  const tempDir = path.join(os.tmpdir(), `agy-test-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const mockConfigFile = path.join(tempDir, 'mock_config.json');

  // Initial mock config with an existing custom server
  const initialConfig = {
    mcpServers: {
      my_custom_db: {
        command: 'npx',
        args: ['-y', 'my-db-mcp']
      }
    }
  };
  fs.writeFileSync(mockConfigFile, JSON.stringify(initialConfig, null, 2), 'utf8');

  // Merge agy-browser configs
  const servers = getBrowserMcpConfigs(path.resolve('.'));
  const mergeResult = mergeMcpConfig(mockConfigFile, servers);

  if (!mergeResult.success) {
    console.error('❌ Merge failed:', mergeResult.error);
    process.exit(1);
  }

  // Verify contents
  const updated = JSON.parse(fs.readFileSync(mockConfigFile, 'utf8'));
  if (!updated.mcpServers.my_custom_db) {
    console.error('❌ Existing server was lost during merge!');
    process.exit(1);
  }

  if (!updated.mcpServers['chrome-devtools'] || !updated.mcpServers['tether-reader']) {
    console.error('❌ New servers were not added properly!');
    process.exit(1);
  }

  if (!mergeResult.backupFile || !fs.existsSync(mergeResult.backupFile)) {
    console.error('❌ Backup file was not created!');
    process.exit(1);
  }

  console.log('✔ Existing servers preserved: my_custom_db');
  console.log('✔ Added servers: chrome-devtools, tether-reader');
  console.log('✔ Backup file created at:', mergeResult.backupFile);
  console.log('✔ Safe JSON merge PASSED!\n');

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('🎉 ALL CONFIG MERGER TESTS PASSED SUCCESSFULLY!');
}

runMergerTest();
