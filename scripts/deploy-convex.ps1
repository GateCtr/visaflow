# Deploy Convex depuis le bon dossier (artifacts/joventy/convex)
# Usage: .\scripts\deploy-convex.ps1
#
# ATTENTION: ne JAMAIS faire "npx convex deploy" depuis la racine du monorepo.
# Le dossier convex/ racine ne contient que _generated/ (types pour le slot-hunter).
# Le vrai code Convex est dans artifacts/joventy/convex/.

$ErrorActionPreference = "Stop"
$originalDir = Get-Location

try {
    Set-Location "$PSScriptRoot\..\artifacts\joventy"
    Write-Host "Deploying Convex from artifacts/joventy/ ..." -ForegroundColor Cyan
    npx convex deploy --yes --env-file "$PSScriptRoot\..\.env.local"
    if ($LASTEXITCODE -ne 0) { throw "Convex deploy failed with exit code $LASTEXITCODE" }
    Write-Host "Done!" -ForegroundColor Green
} finally {
    Set-Location $originalDir
}
