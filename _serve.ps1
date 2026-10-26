# _serve.ps1 -- 备用静态服务器（PowerShell 内置，无需 Node）
#
# 仅在系统里找不到 Node.js 时由 启动.cmd 调用。
# 摄像头 API 需要安全上下文，http://localhost 满足条件。
#
# 注意：本文件必须以「UTF-8 带 BOM」保存，否则 Windows PowerShell 5.1
# 会按本地代码页解析，中文注释与提示会乱码。

param([int]$Port = 5173)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.ico'  = 'image/x-icon'
  '.wasm' = 'application/wasm'
  '.map'  = 'application/json; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

try {
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "  启动失败：端口 $Port 可能已被占用。" -ForegroundColor Red
  Write-Host "  请关掉占用该端口的程序后重试。"
  Write-Host ""
  Read-Host "按回车退出"
  exit 1
}

$rootFull = [System.IO.Path]::GetFullPath($root)
Write-Host ""
Write-Host "  =========================================="
Write-Host "    指尖花开 . Gesture Bloom"
Write-Host "  =========================================="
Write-Host ""
Write-Host "  正在启动服务器，浏览器会自动打开..."
Write-Host "  地址:  http://localhost:$Port"
Write-Host ""
Write-Host "  关闭这个窗口即可停止服务。"
Write-Host ""
Write-Host "  服务器已就绪，等待请求..."
Write-Host ""

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  } catch {
    break
  }

  $req = $ctx.Request
  $res = $ctx.Response

  try {
    $path = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }

    # 防目录穿越：解析后必须仍在项目根目录内
    $full = [System.IO.Path]::GetFullPath((Join-Path $rootFull ($path.TrimStart('/'))))
    if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
      $res.StatusCode = 403
    }
    elseif (Test-Path -LiteralPath $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      if ($mime.ContainsKey($ext)) {
        $res.ContentType = $mime[$ext]
      } else {
        $res.ContentType = 'application/octet-stream'
      }
      $res.Headers.Add('Cache-Control', 'no-cache')

      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $res.ContentLength64 = $msg.Length
      $res.OutputStream.Write($msg, 0, $msg.Length)
    }
  }
  catch {
    # 单个请求出错不应终止整个服务
    try { $res.StatusCode = 500 } catch { }
  }
  finally {
    try { $res.OutputStream.Close() } catch { }
  }
}

$listener.Stop()