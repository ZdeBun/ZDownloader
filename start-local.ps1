param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = $PSScriptRoot

function Update-PathFromRegistry {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Install-Tool {
  param(
    [string]$Name,
    [string]$Command,
    [string]$PackageId
  )

  if (Get-Command $Command -ErrorAction SilentlyContinue) {
    return
  }

  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "$Name is required but WinGet is unavailable. Install it manually, then run start-local.bat again."
  }

  Write-Host "Installing $Name. Windows may ask you to approve the installation..."
  & $winget.Source install --id $PackageId --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "WinGet could not install $Name (exit code $LASTEXITCODE). Install it manually, then run start-local.bat again."
  }

  Update-PathFromRegistry
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$Name installed, but '$Command' is not available on PATH yet. Restart Windows or add it to PATH, then run start-local.bat again."
  }
}

try {
  Update-PathFromRegistry
  Install-Tool -Name "Node.js LTS" -Command "node.exe" -PackageId "OpenJS.NodeJS.LTS"
  Install-Tool -Name "yt-dlp" -Command "yt-dlp.exe" -PackageId "yt-dlp.yt-dlp"
  Install-Tool -Name "FFmpeg" -Command "ffmpeg.exe" -PackageId "Gyan.FFmpeg"

  $port = if ($env:PORT -match "^\d+$") { [int]$env:PORT } else { 3000 }
  $address = "http://127.0.0.1:$port"
  $serverAlreadyRunning = $false
  try {
    $response = Invoke-WebRequest -Uri $address -UseBasicParsing -TimeoutSec 2
    $serverAlreadyRunning = $response.StatusCode -eq 200
  } catch {
    $serverAlreadyRunning = $false
  }

  if (-not $serverAlreadyRunning) {
    $node = (Get-Command node.exe).Source
    $server = Start-Process -FilePath $node -ArgumentList "server.js" -WorkingDirectory $projectRoot -PassThru -WindowStyle Minimized
    Start-Sleep -Seconds 2
    if ($server.HasExited) {
      throw "The local server stopped while starting. Port 3000 may already be in use."
    }
  }

  if (-not $NoBrowser) {
    Start-Process $address
  }
} catch {
  Write-Host ""
  Write-Host "ZDownloader could not start: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
