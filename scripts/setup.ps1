# ====================================================================
#  CHROMETETHER: Dual-Tier Browser & Live Chrome Automation Toolkit
# ====================================================================

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

Set-Location $ProjectDir

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "    🌐 CHROMETETHER: Live Chrome Automation & Web Reader    " -ForegroundColor Yellow
Write-Host "    (ZCode, OpenCode, Claude Code, Cursor, Windsurf, Cline) " -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Node.js runtime
Write-Host "[1/4] Checking prerequisites..." -ForegroundColor White
try {
    $nodeVersion = & node -v
    Write-Host "  ✔ Node.js detected: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  ❌ Node.js is required but not found in PATH." -ForegroundColor Red
    Write-Host "     Please install Node.js from https://nodejs.org" -ForegroundColor Yellow
    exit 1
}

# 2. Check dependencies
Write-Host "[2/4] Verifying dependencies..." -ForegroundColor White
if (-not (Test-Path "$ProjectDir\node_modules")) {
    Write-Host "  Installing project dependencies (npm install)..." -ForegroundColor Yellow
    & npm install
} else {
    Write-Host "  ✔ Dependencies already installed in node_modules." -ForegroundColor Green
}

# 3. Detect agents
Write-Host "[3/4] Scanning local AI Agent environments..." -ForegroundColor White
& node "$ProjectDir\bin\chrometether.js" status

Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "Select an installation action:" -ForegroundColor Yellow
Write-Host "  [1] Install to ALL detected Agent configurations (Recommended)" -ForegroundColor Cyan
Write-Host "  [2] Install to ZCode (Z.ai)" -ForegroundColor White
Write-Host "  [3] Install to OpenCode CLI" -ForegroundColor White
Write-Host "  [4] Install to Claude Code CLI" -ForegroundColor White
Write-Host "  [5] Install to Claude Desktop" -ForegroundColor White
Write-Host "  [6] Install to Cursor IDE" -ForegroundColor White
Write-Host "  [7] Install to Windsurf" -ForegroundColor White
Write-Host "  [8] Install to Roo Code / Cline (VS Code)" -ForegroundColor White
Write-Host "  [9] Run Diagnostics / Health Check" -ForegroundColor Green
Write-Host "  [0] Exit" -ForegroundColor Red
Write-Host ""

$choice = Read-Host "Enter your choice [1-9, default 1]"
if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "1" }

switch ($choice) {
    "1" {
        & node "$ProjectDir\bin\chrometether.js" install all
    }
    "2" {
        & node "$ProjectDir\bin\chrometether.js" install zcode
    }
    "3" {
        & node "$ProjectDir\bin\chrometether.js" install opencode
    }
    "4" {
        & node "$ProjectDir\bin\chrometether.js" install claude-code
    }
    "5" {
        & node "$ProjectDir\bin\chrometether.js" install claude-desktop
    }
    "6" {
        & node "$ProjectDir\bin\chrometether.js" install cursor
    }
    "7" {
        & node "$ProjectDir\bin\chrometether.js" install windsurf
    }
    "8" {
        & node "$ProjectDir\bin\chrometether.js" install roo-code
        & node "$ProjectDir\bin\chrometether.js" install cline
    }
    "9" {
        & node "$ProjectDir\bin\chrometether.js" test
    }
    "0" {
        Write-Host "Installation canceled." -ForegroundColor Gray
        exit 0
    }
    Default {
        & node "$ProjectDir\bin\chrometether.js" install all
    }
}

Write-Host ""
Write-Host "[4/4] Installation process complete!" -ForegroundColor Green
Write-Host "Restart your target AI Agent to load the newly registered MCP servers." -ForegroundColor Yellow
Write-Host ""
