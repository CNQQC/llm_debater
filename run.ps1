# 一键启动脚本（Windows PowerShell）
# 首次运行会自动创建虚拟环境并安装依赖；之后直接启动服务。
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$venv = Join-Path $root ".venv"
$py = Join-Path $venv "Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Host "首次运行：创建虚拟环境并安装依赖…" -ForegroundColor Cyan
    python -m venv $venv
    & $py -m pip install --upgrade pip
    & $py -m pip install -r (Join-Path $root "requirements.txt")
}

$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $root ".env.example") $envFile
    Write-Host "已生成 .env —— 请填入至少一个提供商的 API Key 后重新运行本脚本。" -ForegroundColor Yellow
    exit 0
}

Write-Host "启动服务： http://localhost:8000" -ForegroundColor Green
& $py -m uvicorn backend.server:app --reload --port 8000
