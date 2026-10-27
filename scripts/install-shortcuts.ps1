# Creates (or removes with -Remove) the AURA shortcuts on the Desktop and in the
# Start Menu, so AURA opens like any other app. No administrator rights needed.
param([switch]$Remove)

$root = Split-Path -Parent $PSScriptRoot
$places = @(
  [Environment]::GetFolderPath("Desktop"),
  [Environment]::GetFolderPath("Programs")
)

if ($Remove) {
  foreach ($dir in $places) {
    $path = Join-Path $dir "AURA.lnk"
    if (Test-Path $path) {
      Remove-Item $path
      Write-Output "Removed $path"
    }
  }
  exit 0
}

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $places) {
  $path = Join-Path $dir "AURA.lnk"
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
  $link.Arguments = '"' + (Join-Path $root "scripts\AURA.vbs") + '"'
  $link.WorkingDirectory = $root
  $link.IconLocation = (Join-Path $root "scripts\aura.ico") + ",0"
  $link.Description = "AURA, personal planner"
  $link.Save()
  Write-Output "Created $path"
}
Write-Output "Tip: right-click the AURA icon and choose Pin to taskbar or Pin to Start."
