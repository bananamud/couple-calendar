# 情侣日历启动器：自动找到（必要时下载）Node.js，然后启动服务。
# 由「启动情侣日历.bat」「启动并分享给外网.bat」调用。
param(
  [switch]$Share,          # 启动公网分享模式
  [switch]$Package,        # 打包「只含软件」的 zip
  [switch]$ForcePortable,  # 忽略系统里的 Node，强制用便携版（测试用）
  [switch]$DryRun          # 只检查/准备 Node，不启动服务（测试用）
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Port = if ($env:PORT) { $env:PORT } else { '5178' }
$PortableDir = Join-Path $Root '.runtime\node'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Find-Node {
  if (-not $ForcePortable) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }

    $candidates = @(
      "$env:ProgramFiles\nodejs\node.exe",
      "${env:ProgramFiles(x86)}\nodejs\node.exe",
      "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    foreach ($c in $candidates) {
      if ($c -and (Test-Path $c)) { return $c }
    }
  }

  # 项目里的便携版（之前自动下载过；放在项目目录里最稳）
  if (Test-Path $PortableDir) {
    $hit = Get-ChildItem $PortableDir -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }

  if (-not $ForcePortable) {
    # Codex 自带运行时目录里的 node（版本号会变，所以按目录搜）
    foreach ($base in @("$env:LOCALAPPDATA\OpenAI\Codex\runtimes", "$env:USERPROFILE\.cache\codex-runtimes")) {
      if (Test-Path $base) {
        $hit = Get-ChildItem $base -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -notmatch 'node_modules' } | Select-Object -First 1
        if ($hit) { return $hit.FullName }
      }
    }
  }
  return $null
}

function Install-PortableNode {
  Say ''
  Say '  这台电脑还没装 Node.js，正在自动下载便携版（约 36MB，只会下载这一次）…' 'Yellow'
  $progress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    # 1. 找一个可用的 LTS 版本号（国内镜像优先，官网友情备份）
    $version = 'v24.21.0'
    foreach ($idx in @('https://registry.npmmirror.com/-/binary/node/index.json',
                       'https://nodejs.org/dist/index.json')) {
      try {
        $index = Invoke-RestMethod $idx -TimeoutSec 20
        $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
        if ($lts -and $lts.version) { $version = $lts.version; break }
      } catch { }
    }

    # 2. 依次尝试国内镜像和官网
    $zipName = "node-$version-win-x64.zip"
    $tmpZip = Join-Path $env:TEMP $zipName
    $sources = @(
      "https://registry.npmmirror.com/-/binary/node/$version/$zipName",
      "https://npmmirror.com/mirrors/node/$version/$zipName",
      "https://nodejs.org/dist/$version/$zipName"
    )
    $ok = $false
    foreach ($src in $sources) {
      Say "  下载源：$src" 'DarkGray'
      try {
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
          & curl.exe -L --fail --retry 2 --connect-timeout 20 -o $tmpZip $src
          if ($LASTEXITCODE -ne 0) { throw "curl 退出码 $LASTEXITCODE" }
        } else {
          Invoke-WebRequest -Uri $src -OutFile $tmpZip -TimeoutSec 900 -UseBasicParsing
        }
        if ((Test-Path $tmpZip) -and ((Get-Item $tmpZip).Length -gt 5MB)) { $ok = $true; break }
        throw '下载的文件不完整'
      } catch {
        Say "  这个源没成功：$($_.Exception.Message)" 'DarkGray'
        Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
      }
    }
    if (-not $ok) { throw '所有下载源都失败了' }

    Say '  解压中…'
    $extract = Join-Path $env:TEMP "cc-node-$version"
    if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
    Expand-Archive -LiteralPath $tmpZip -DestinationPath $extract -Force
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PortableDir) | Out-Null
    $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
    if (Test-Path $PortableDir) { Remove-Item $PortableDir -Recurse -Force }
    Move-Item -LiteralPath $inner.FullName -Destination $PortableDir
    Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    Say ''
    Say '  自动下载失败（可能是网络问题）。' 'Red'
    Say '  你可以手动安装 Node.js：https://nodejs.org  （一路点下一步即可），装完再双击一次。'
    Say "  错误信息：$($_.Exception.Message)" 'DarkGray'
    Say ''
    exit 1
  } finally {
    $ProgressPreference = $progress
  }
  $found = Get-ChildItem $PortableDir -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) {
    Say '  下载完成但没找到 node.exe，请手动安装 Node.js：https://nodejs.org' 'Red'
    exit 1
  }
  Say '  ✓ Node.js 便携版已就绪' 'Green'
  return $found.FullName
}

function Test-ServerUp {
  try {
    $res = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing
    return $res.StatusCode -eq 200
  } catch {
    return $false
  }
}

$nodePath = Find-Node
if (-not $nodePath) { $nodePath = Install-PortableNode }

$version = (& $nodePath --version) 2>$null
Say ''
Say "  使用 Node.js $version  ($nodePath)" 'DarkGray'

if ($DryRun) {
  Say '  [DryRun] 只检查环境，不启动服务。' 'DarkGray'
  exit 0
}

if ($Share) {
  Say '  正在启动公网分享模式…' 'Cyan'
  Say '  （这个窗口关掉，公网地址就会失效；局域网访问不受影响）' 'DarkGray'
  Say ''
  & $nodePath (Join-Path $Root 'tools\share.mjs')
  Say ''
  Say '  已停止。按任意键关闭窗口。'
  exit 0
}

if ($Package) {
  Say '  正在打包分发包…' 'Cyan'
  Say '  （会排除你们的日历数据、访问密钥和运行库，打包好放在「分发包」文件夹里）' 'DarkGray'
  Say ''
  & $nodePath (Join-Path $Root 'tools\make-package.mjs')
  Say ''
  Say '  按任意键关闭窗口。'
  exit 0
}

if (Test-ServerUp) {
  Say '  日历服务已经在运行，直接帮你打开浏览器。' 'Green'
  if (-not $env:CC_NO_BROWSER) { Start-Process "http://localhost:$Port" }
  Say '  （想换端口：先关掉那个正在运行的窗口，再重新双击本文件）' 'DarkGray'
  Start-Sleep -Seconds 4
  exit 0
}

Say '  正在启动情侣日历，稍后会自动打开浏览器…' 'Cyan'
if (-not $env:CC_NO_BROWSER) {
  Start-Process powershell -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
    "Start-Sleep 3; Start-Process 'http://localhost:$Port'" -WindowStyle Hidden
}
& $nodePath (Join-Path $Root 'server.js')
Say ''
Say '  服务已停止。按任意键关闭窗口。'
