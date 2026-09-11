<#
将 dist/ 下的 APK 与更新清单上传为 GitHub Release，供 App 的 GitHub 更新通道读取。

先运行 .\gradlew.bat publishRelease 生成产物，本脚本只负责上传；版本号取自
dist/update.json，所以发布什么版本由构建决定，不在这里重复声明。

用法：
  .\publish-release.ps1
  .\publish-release.ps1 -Repo 19836029013/liquid-glass-ai-chat -Branch main
#>
param(
  [string]$Repo = '19836029013/liquid-glass-ai-chat',
  [string]$Branch = 'p0/security-hardening'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'
$apk = Join-Path $dist 'DSH-Remote.apk'
$manifest = Join-Path $dist 'update.json'

foreach ($required in @($apk, $manifest)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "缺少 $required；先运行 .\gradlew.bat publishRelease"
  }
}

# 资产名必须与 RemoteService 拼出的路径一致：<base>/update.json 与 <base>/DSH-Remote.apk。
$info = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
$tag = "v$($info.versionName)"
$notes = "versionCode $($info.versionCode)`nSHA-256 $($info.sha256)"

gh release view $tag --repo $Repo *> $null
if ($LASTEXITCODE -eq 0) {
  gh release upload $tag $apk $manifest --repo $Repo --clobber
  Write-Host "已更新 Release $tag 的资产"
} else {
  gh release create $tag $apk $manifest --repo $Repo --target $Branch `
    --title "DSH Remote $($info.versionName)" --notes $notes
  Write-Host "已创建 Release $tag"
}

Write-Host "App 读取地址: https://github.com/$Repo/releases/latest/download/update.json"
