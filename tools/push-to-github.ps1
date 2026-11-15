# Publish this repo to GitHub.
# Usage:  pwsh -File tools/push-to-github.ps1 -Owner <your-github-login> [-Repo dsh-decisions-board] [-Token <pat>]
# Notes:
#   * git push cannot create a repository. If the repo does not exist yet, this script says so and stops;
#     create it once at https://github.com/new (public, no README/gitignore/license) and re-run.
#   * Without -Token the push uses git's credential manager and may open a browser prompt once.
param(
  [Parameter(Mandatory=$true)][string]$Owner,
  [string]$Repo = 'dsh-decisions-board',
  [string]$Token = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  if (-not (Test-Path .git)) { throw 'not a git repo' }
  $api = "https://api.github.com/repos/$Owner/$Repo"
  $exists = $false
  try {
    $null = Invoke-WebRequest -Uri $api -UseBasicParsing -TimeoutSec 20
    $exists = $true
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 404) {
      Write-Host "REPO NOT FOUND: $Owner/$Repo" -ForegroundColor Yellow
      Write-Host 'Create it first (public, empty, no README): https://github.com/new' -ForegroundColor Yellow
      Write-Host "Then re-run: pwsh -File tools/push-to-github.ps1 -Owner $Owner"
      exit 2
    }
    Write-Host "probe failed with $code - continuing anyway" -ForegroundColor DarkYellow
  }
  if (-not $exists) { Write-Host 'probe inconclusive, attempting push' -ForegroundColor DarkYellow }

  if ($Token -ne '') {
    $url = "https://$Owner`:$Token@github.com/$Owner/$Repo.git"
  } else {
    $url = "https://github.com/$Owner/$Repo.git"
  }

  $remotes = git remote
  if ($remotes -contains 'origin') { git remote set-url origin $url } else { git remote add origin $url }
  Write-Host "remote origin -> https://github.com/$Owner/$Repo.git"

  git push -u origin main
  if ($LASTEXITCODE -ne 0) { throw "push failed (exit $LASTEXITCODE)" }

  Write-Host ''
  Write-Host 'Pushed. Next steps for the marketplace submission:' -ForegroundColor Green
  Write-Host '  1. Repo -> About -> add topic: dsh-plugin'
  Write-Host '  2. Wait until the repo is 24h old (CI checks created_at)'
  Write-Host '  3. Replace OWNER in marketplace/OWNER__dsh-decisions-board.yml with your login, then open the PR'
} finally {
  Pop-Location
}
