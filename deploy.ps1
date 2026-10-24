# One-command deployment of LOF CRM to Cloudflare (Windows PowerShell). Safe to run again for updates. See DEPLOY.md.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 first: https://nodejs.org' }
if ([int](node -p "process.versions.node.split('.')[0]") -lt 22) { throw 'Node.js 22 or newer is needed' }

function Read-Secret($prompt) { $s = Read-Host $prompt -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
if (-not $env:CLOUDFLARE_ACCOUNT_ID) { $env:CLOUDFLARE_ACCOUNT_ID = Read-Host 'Cloudflare account ID' }
if (-not $env:CLOUDFLARE_API_TOKEN)  { $env:CLOUDFLARE_API_TOKEN = Read-Secret 'Cloudflare API token' }
if (-not $env:ADMIN_EMAIL) { $env:ADMIN_EMAIL = Read-Host 'Administrator e-mail (blank to skip on updates)' }
if ($env:ADMIN_EMAIL -and -not $env:ADMIN_PASSWORD) { $env:ADMIN_PASSWORD = Read-Secret 'Administrator password (10+ characters, letters and numbers; changed at first sign-in)' }

Write-Host '> Installing and testing'
npm ci --no-audit --no-fund; if ($LASTEXITCODE) { exit $LASTEXITCODE }
npm run typecheck;          if ($LASTEXITCODE) { exit $LASTEXITCODE }
npm test;                   if ($LASTEXITCODE) { exit $LASTEXITCODE }
node scripts/cf-deploy.mjs @args
exit $LASTEXITCODE
