#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

echo "============================================================"
echo "    🌐 CHROMETETHER: Live Chrome Automation & Web Reader    "
echo "============================================================"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not found in PATH."
    exit 1
fi

# Verify dependencies
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    echo "Installing project dependencies..."
    npm install
fi

# Run installer
node "$PROJECT_DIR/bin/chrometether.js" install all

echo "✔ Installation complete! Restart your target AI agent to load MCP tools."
