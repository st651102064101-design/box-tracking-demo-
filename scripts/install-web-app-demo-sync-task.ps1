<#
.SYNOPSIS
Installs the Windows scheduled task that runs sync-web-app-demo.ps1.

.DESCRIPTION
The task runs only while the current user is logged in, matching Docker
Desktop's normal desktop-session requirement. It starts immediately and then
repeats every five minutes.
#>
[CmdletBinding()]
param(
    [string]$RepositoryPath = (Split-Path -Parent $PSScriptRoot),
    [string]$TaskName = 'BoxTracking-WebAppDemo-Sync'
)

$ErrorActionPreference = 'Stop'
$syncScript = Join-Path $RepositoryPath 'scripts\sync-web-app-demo.ps1'

if (-not (Test-Path -LiteralPath $syncScript)) {
    throw "Sync script not found: $syncScript"
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$syncScript`""
$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 9999)
$principal = New-ScheduledTaskPrincipal `
    -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Description 'Pull WEB_APP_DEMO and rebuild the Box Tracking frontend when it changes.' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed and started '$TaskName'."
