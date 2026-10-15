# Build a portable "unzip-and-run" package: electron runtime + app code => zip
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-portable.ps1
# Output:
#   release\<name>-<version>-win-x64.zip  (zip contains a top-level <name>/ folder, unzip then run the exe)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $pkg.version
$name = $pkg.name

$relDir   = Join-Path $root 'release'
$staging  = Join-Path $relDir '_staging'       # zip top-level dir source
$appDir   = Join-Path $staging $name          # this is the unzipped folder
$distDir  = Join-Path $root 'node_modules\electron\dist'
$zipPath  = Join-Path $relDir "$name-$ver-win-x64.zip"

if (-not (Test-Path $distDir)) { throw "electron dist not found: $distDir (run npm install first)" }

# clean previous output
foreach ($p in @($staging, $zipPath)) {
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# 1. copy electron runtime
robocopy $distDir $appDir /E /NFL /NDL /NJH /NJS /np | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy electron runtime failed (exit $LASTEXITCODE)" }

# 2. remove the default sample app, put our app into resources\app
$resDir = Join-Path $appDir 'resources'
Remove-Item -Force (Join-Path $resDir 'default_app.asar') -ErrorAction SilentlyContinue
$resApp = Join-Path $resDir 'app'
New-Item -ItemType Directory -Force -Path $resApp | Out-Null

$items = @('package.json', 'src', 'vendor', 'pricing.json', 'LICENSE', 'THIRD-PARTY.md', 'README.md', 'CHANGELOG.md')
foreach ($item in $items) {
  $src = Join-Path $root $item
  $dst = Join-Path $resApp $item
  if (-not (Test-Path $src)) { continue }
  if ((Get-Item $src).PSIsContainer) {
    robocopy $src $dst /E /NFL /NDL /NJH /NJS /np | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $item (exit $LASTEXITCODE)" }
  } else {
    Copy-Item -Force -Path $src -Destination $dst
  }
}

# 3. rename exe for a clearer double-click entry
$exe = Join-Path $appDir 'electron.exe'
$newExe = Join-Path $appDir "$name.exe"
if (Test-Path $newExe) { Remove-Item -Force $newExe }
Rename-Item -Force -Path $exe -NewName "$name.exe"

# 4. zip (keep the top-level <name>/ folder inside the zip)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)

# 5. keep both the zip and the ready-to-run folder at release\<name>
$finalDir = Join-Path $relDir $name
if (Test-Path $finalDir) { Remove-Item -Recurse -Force $finalDir }
Move-Item -Path $appDir -Destination $finalDir
Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
$zipSizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
$appSizeMB = [math]::Round(((Get-ChildItem -Recurse $finalDir | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)

Write-Host ''
Write-Host "Build OK:"
Write-Host "  zip : $zipPath ($zipSizeMB MB)"
Write-Host "  dir : $finalDir ($appSizeMB MB)"
Write-Host "  use : unzip, then double-click $name.exe. No install needed."