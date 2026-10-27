# Waits until the local AURA server answers, then opens it.
# Mode "browser" uses the default browser; "app" opens a Microsoft Edge app window.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Mode = "browser",
  [switch]$NoWait
)

if ($Mode -eq "none") { exit 0 }

if (-not $NoWait) {
  for ($i = 0; $i -lt 60; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$Url/api/health" -TimeoutSec 1 | Out-Null
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
}

if ($Mode -eq "app") {
  $edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($edge) {
    Start-Process -FilePath $edge -ArgumentList "--app=$Url"
    exit 0
  }
}

Start-Process $Url
