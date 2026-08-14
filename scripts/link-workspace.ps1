# Creates junction mirrors of a dsh-meow pnpm workspace's @deepseek-ai/*
# packages under this plugin's node_modules, so esbuild can resolve both this
# plugin's direct imports and the transitive imports of bundled packages.
#
# The built lib/index.js is self-contained (esbuild bundles everything), so
# these links are only needed at BUILD time, never at runtime.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/link-workspace.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/link-workspace.ps1 -MeowRoot D:\path\to\dsh-meow
#
# This script is Windows-only (NTFS junctions). On macOS/Linux, replace the
# junction with a symlink (ln -s) — the layout is identical.

param(
  [string]$MeowRoot = "D:\myFiles\dsh\dsh-meow"
)

$ErrorActionPreference = 'Stop'
$linkRoot = Join-Path $PSScriptRoot "..\node_modules\@deepseek-ai"
New-Item -ItemType Directory $linkRoot -Force | Out-Null
$found = 0

function Try-Link($dir) {
  $pjFile = Join-Path $dir "package.json"
  if (-not (Test-Path $pjFile)) { return }
  try {
    $raw = [System.IO.File]::ReadAllText($pjFile, [System.Text.Encoding]::UTF8)
    $pj = $raw | ConvertFrom-Json
    if ($pj.name -and $pj.name.StartsWith("@deepseek-ai/")) {
      $name = $pj.name.Substring(13)
      $link = Join-Path $linkRoot $name
      if (-not (Test-Path $link)) {
        New-Item -ItemType Junction -Path $link -Target $dir | Out-Null
        $script:found++
      }
    }
  } catch {
    Write-Host "skip $($dir): $($_.Exception.Message)"
  }
}

if (-not (Test-Path (Join-Path $MeowRoot "pnpm-workspace.yaml"))) {
  Write-Host "ERROR: $MeowRoot does not look like a dsh-meow workspace (pnpm-workspace.yaml missing)"
  exit 1
}

Get-ChildItem (Join-Path $MeowRoot "packages") -Directory -Recurse -Depth 1 -ErrorAction SilentlyContinue | ForEach-Object { Try-Link $_ }
Get-ChildItem (Join-Path $MeowRoot "vendor") -Directory -ErrorAction SilentlyContinue | ForEach-Object { Try-Link $_ }

Write-Host "created $found new junctions; total: $((Get-ChildItem $linkRoot).Count) in $linkRoot"
