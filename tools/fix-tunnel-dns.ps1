# 绕过 api.trycloudflare.com 的 DNS 污染：把域名固定到真实的 Cloudflare IP。
# 只影响这一个域名；隧道数据通道（argotunnel.com）实测没有被污染，不需要处理。
param([switch]$Elevated)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$domain = 'api.trycloudflare.com'
$ip = '104.16.230.132'
$marker = '# 情侣日历：绕过 api.trycloudflare.com 的 DNS 污染'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Find-Entry {
  if (-not (Test-Path $hostsFile)) { return $null }
  Get-Content -LiteralPath $hostsFile -ErrorAction SilentlyContinue |
    Where-Object { $_ -match "^\s*[\d\.]+\s+$([regex]::Escape($domain))\s*$" } |
    Select-Object -First 1
}

function Test-TunnelApi {
  try {
    $res = Invoke-WebRequest -Uri "https://$domain/" -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
    return "HTTP $($res.StatusCode)"
  } catch {
    if ($_.Exception.Response) { return "HTTP $([int]$_.Exception.Response.StatusCode)" }
    return $_.Exception.Message
  }
}

Say ''
Say '  情侣日历 · 修复公网隧道 DNS' 'Cyan'
Say '  ────────────────────────────'
Say ''

$existing = Find-Entry
if ($existing) {
  Say "  已经配置过了：$existing" 'Green'
  Say "  连通性自检：$(Test-TunnelApi)"
  Say ''
  Say '  按任意键关闭窗口。'
  exit 0
}

if (-not $Elevated) {
  Say '  api.trycloudflare.com 在当前网络下会被解析到伪造 IP（证书验不过），' 'Yellow'
  Say '  所以公网隧道建不起来。下面会把这个域名固定到真实的 Cloudflare IP。' 'Yellow'
  Say ''
  Say '  修改 hosts 文件需要管理员权限，稍后会弹出「用户账户控制」，请点「是」。' 'Yellow'
  Say ''
  try {
    Start-Process -FilePath 'powershell' -Verb RunAs -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated'
    ) | Out-Null
    Say '  已弹出授权窗口。' 'Gray'
  } catch {
    Say "  没能弹出授权窗口：$($_.Exception.Message)" 'Red'
    Say '  可以手动把下面这行加到 hosts 文件（记事本以管理员身份打开）：' 'Yellow'
    Say "      $ip    $domain"
  }
  Say ''
  Say '  按任意键关闭窗口。'
  exit 0
}

# 已经提权：写入 hosts
try {
  Copy-Item -LiteralPath $hostsFile -Destination "$hostsFile.ccbak" -Force -ErrorAction SilentlyContinue
  Add-Content -LiteralPath $hostsFile -Value "`r`n$marker`r`n$ip`t$domain" -Encoding ASCII
  Say "  已写入：$ip`t$domain" 'Green'
  ipconfig /flushdns | Out-Null
  Say '  已刷新 DNS 缓存。' 'Gray'
  Say ''
  Say "  连通性自检：$(Test-TunnelApi)" 'Green'
  Say ''
  Say '  现在可以重新双击「启动并分享给外网.bat」了。' 'Cyan'
} catch {
  Say "  写入失败：$($_.Exception.Message)" 'Red'
  Say '  可以手动把下面这行加到 hosts 文件：' 'Yellow'
  Say "      $ip    $domain"
}
Say ''
Say '  按任意键关闭窗口。'
