import { fetchMarkdown } from '../src/reader-server/fetch-markdown.js';
import { searchDDG } from '../src/reader-server/search-ddg.js';

async function runTests() {
  console.log('=== Testing Tier 1: Fast Reader ===\n');

  // Test 1: Fetch Markdown
  console.log('1. Testing fetchMarkdown(https://example.com)...');
  try {
    const page = await fetchMarkdown('https://example.com');
    console.log('✔ Title:', page.title);
    console.log('✔ Content snippet:\n', page.content.slice(0, 150));
    console.log('✔ fetchMarkdown PASSED\n');
  } catch (err) {
    console.error('❌ fetchMarkdown FAILED:', err.message);
    process.exit(1);
  }

  // Test 2: Search DuckDuckGo
  console.log('2. Testing searchDDG("Node.js website")...');
  try {
    const results = await searchDDG('Node.js website', 3);
    console.log(`✔ Found ${results.length} results:`);
    results.forEach((r, i) => console.log(`   ${i + 1}. ${r.title} -> ${r.link}`));
    console.log('✔ searchDDG PASSED\n');
  } catch (err) {
    console.error('❌ searchDDG FAILED:', err.message);
    process.exit(1);
  }

  console.log('🎉 ALL TIER 1 TESTS PASSED SUCCESSFULLY!');
}

runTests();
