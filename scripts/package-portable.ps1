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

# 3.5 替换 exe 图标（深海回响）—— Electron 默认图标是它自己的原子标，必须用
#     rcedit 改写 PE 资源里的图标。rcedit 随 electron-builder 的 winCodeSign 缓存分发，
#     本机不装它也常见，所以找不到就跳过并告警（不阻断打包）。
$iconSrc = Join-Path $root 'build\icon.ico'
if (Test-Path $iconSrc) {
  $rcedit = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign') `
    -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
  if ($rcedit) {
    & $rcedit $newExe --set-icon $iconSrc | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "rcedit 设置图标失败（exit $LASTEXITCODE），exe 仍是 Electron 默认图标" }
    else { Write-Host "  icon: 已写入 $iconSrc (rcedit)" }
  } else {
    Write-Warning "未找到 rcedit-x64.exe（electron-builder\Cache\winCodeSign），跳过 exe 图标替换"
  }
} else {
  Write-Warning "未找到 build\icon.ico，跳过 exe 图标替换"
}

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