<#
.SYNOPSIS
Synchronizes WEB_APP_DEMO and rebuilds the frontend when it changes.

.DESCRIPTION
Designed for a dedicated clone on a Windows machine running Docker Desktop.
It never overwrites local modifications: if the checkout is dirty, it logs the
condition and exits so the user can resolve it deliberately.
#>
[CmdletBinding()]
param(
    [string]$RepositoryPath = (Split-Path -Parent $PSScriptRoot),
    [string]$Branch = 'WEB_APP_DEMO'
)

$ErrorActionPreference = 'Stop'
$logDirectory = Join-Path $RepositoryPath '.cursor\logs'
$logFile = Join-Path $logDirectory 'web-app-demo-sync.log'

function Write-Log {
    param([string]$Message)

    $line = '{0:u} {1}' -f (Get-Date), $Message
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    Add-Content -Path $logFile -Value $line
    Write-Output $line
}

function Invoke-CheckedCommand {
    param(
        [string]$Command,
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE."
    }
}

try {
    Set-Location $RepositoryPath
    Invoke-CheckedCommand -Command 'git' -Arguments @('rev-parse', '--is-inside-work-tree')

    $currentBranch = (& git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to determine the current Git branch.'
    }
    if ($currentBranch -ne $Branch) {
        throw "Checkout is on '$currentBranch', not '$Branch'."
    }

    $changes = & git status --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to inspect Git working-tree status.'
    }
    if ($changes) {
        Write-Log "Skipped: local changes exist; '$Branch' was not updated."
        exit 2
    }

    Invoke-CheckedCommand -Command 'git' -Arguments @('fetch', 'origin', $Branch)
    $localCommit = (& git rev-parse 'HEAD').Trim()
    $remoteCommit = (& git rev-parse "origin/$Branch").Trim()
    if ($localCommit -eq $remoteCommit) {
        Write-Log "No update: $Branch is already at $localCommit."
        exit 0
    }

    Invoke-CheckedCommand -Command 'git' -Arguments @('merge', '--ff-only', "origin/$Branch")
    Invoke-CheckedCommand -Command 'docker' -Arguments @('compose', 'up', '-d', '--build', '--no-deps', 'frontend')
    Write-Log "Updated $Branch from $localCommit to $remoteCommit and recreated frontend."
}
catch {
    Write-Log "Failed: $($_.Exception.Message)"
    exit 1
}
