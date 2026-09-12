[CmdletBinding()]
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSCommandPath
$ProductName = '西北大学教务知识问答系统'

function Invoke-CheckedCommand {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  Write-Host "[检查] $Label"
  & $Command
  if ($LASTEXITCODE) {
    throw "$Label 失败，退出码：$LASTEXITCODE"
  }
}

Push-Location $ProjectRoot
try {
  if (-not $SkipBuild) {
    Push-Location 'deepseek-harness-master\deepseek-harness-master'
    try {
      Invoke-CheckedCommand '构建内置 DSH 运行时' { pnpm build }
    } finally {
      Pop-Location
    }

    Push-Location 'web'
    try {
      Invoke-CheckedCommand '构建独立 Web 前端' { npm run build }
    } finally {
      Pop-Location
    }
  }

  Invoke-CheckedCommand '校验站点配置和运行数据' {
    $cfg = Get-Content -Raw -Encoding UTF8 'config\nwu.json' | ConvertFrom-Json
    $data = Get-Content -Raw -Encoding UTF8 'data\site_data.json' | ConvertFrom-Json
    foreach ($item in @($cfg.site, $data)) {
      if ($item.title -ne $ProductName -or $item.brand -ne $ProductName) {
        throw '站点配置或 data/site_data.json 的产品名称未同步'
      }
    }
  }
  Invoke-CheckedCommand '校验仓库可移植配置' {
    $files = @('nwu.cordis.yml', 'presets\office-qa\agent.cordis.yml', 'presets\knowledge-build\agent.cordis.yml', 'dsh-nwu\test-smoke.mjs')
    foreach ($file in $files) {
      $text = Get-Content -Raw -Encoding UTF8 $file
      if ($text -match 'file:///[A-Za-z]:/' -or $text -match '[A-Za-z]:\\') {
        throw "$file 仍包含本机绝对路径"
      }
    }
  }
  if (-not (Test-Path 'dsh-nwu-intake\public\nwu-background.webp')) {
    throw '缺少项目自有的背景资源。'
  }
  if (Test-Path '背景') {
    Write-Warning '检测到旧 Wallpaper Engine 素材目录。该目录不会进入 Git 仓库。'
  }
  Invoke-CheckedCommand '校验 DSH 挂载配置' {
    node 'tools\run_nwu.mjs' web --dump-config | Out-Null
  }
  Invoke-CheckedCommand '运行只读工具冒烟测试' { node 'dsh-nwu\test-smoke.mjs' }

  Push-Location 'dsh-nwu'
  try {
  Invoke-CheckedCommand '运行知识维护与发布链路测试' { node test-product.mjs }
  } finally {
    Pop-Location
  }

  Write-Host ''
  Write-Host '发布前检查通过。如需浏览器验收，请按 README 安装 Playwright 后运行 tools/test_nwu_web.py。'
  Write-Host '公开发布前请确认演示数据引用的官方网页政策版本与链接有效性。'
} finally {
  Pop-Location
}
