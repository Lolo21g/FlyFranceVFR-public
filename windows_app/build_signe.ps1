<#
.SYNOPSIS
    Construit l'installateur FlyFranceVFR et signe les executables via SignPath.

.DESCRIPTION
    Etape 0 : les deux executables de l'application doivent etre construits et presents
    dans inno_package\ (workflow actuel : publish dotnet pour FlyFranceVFR.exe,
    PyInstaller pour FlyFranceVFR_Bridge.exe).

    Etapes effectuees par ce script :
      1. Signature de inno_package\FlyFranceVFR.exe via SignPath
      2. Signature de inno_package\bridge\FlyFranceVFR_Bridge.exe via SignPath
      3. Compilation de l'installateur avec Inno Setup (ISCC)
      4. Signature de l'installateur Setup_FlyFranceVFR_*.exe via SignPath
      5. Verification de toutes les signatures (Get-AuthenticodeSignature)

    Le module PowerShell officiel "SignPath" est installe automatiquement si besoin.
    Les slugs (projet, politique, config d'artefact) sont visibles dans
    https://app.signpath.io (page du projet). Le token ne doit JAMAIS etre
    ecrit en clair dans un fichier : repondez a l'invite securisee ou passez-le
    via la variable d'environnement SIGNPATH_API_TOKEN.

.EXAMPLE
    .\build_signe.ps1 -OrganizationId "12345678-abcd-..." `
                      -ProjectSlug "FlyFranceVFR" `
                      -SigningPolicySlug "release-signing" `
                      -ArtifactConfigurationSlug "release"
#>

[CmdletBinding()]
param(
    # Identifiant de l'organisation SignPath (app.signpath.io > Organisation > Settings)
    [Parameter(Mandatory = $true)][string]$OrganizationId,

    # Slug du projet SignPath (ex. "FlyFranceVFR")
    [Parameter(Mandatory = $true)][string]$ProjectSlug,

    # Slug de la politique de signature (ex. "release-signing")
    [Parameter(Mandatory = $true)][string]$SigningPolicySlug,

    # Slug de la configuration d'artefact (ex. "release-signing")
    [Parameter(Mandatory = $true)][string]$ArtifactConfigurationSlug,

    # Token d'API SignPath. Demande interactivement si absent.
    [string]$ApiToken,

    # Chemin de ISCC.exe (Inno Setup 6)
    [string]$IsccPath = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",

    # Ne pas signer FlyFranceVFR.exe / FlyFranceVFR_Bridge.exe (ex. re-signature installateur seul)
    [switch]$SkipSignAppExes,

    # Ne pas lancer ISCC (l'installateur existe deja ; on se contente de le signer)
    [switch]$SkipCompileInstaller,

    [string]$Version = "0.7.5"
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Chemins
# ---------------------------------------------------------------------------
$windowsAppDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$innoPackageDir = Join-Path $windowsAppDir 'inno_package'
$issFile        = Join-Path $windowsAppDir 'FlyFranceVFR_Inno.iss'
$outputDir      = Join-Path $windowsAppDir 'inno_output'

$appExe    = Join-Path $innoPackageDir 'FlyFranceVFR.exe'
$bridgeExe = Join-Path $innoPackageDir 'bridge\FlyFranceVFR_Bridge.exe'

if (-not (Test-Path $appExe))    { throw "Executable introuvable : $appExe (construisez d'abord l'application)" }
if (-not (Test-Path $bridgeExe)) { throw "Executable introuvable : $bridgeExe" }

# ---------------------------------------------------------------------------
# Token SignPath (jamais en clair dans un fichier)
# ---------------------------------------------------------------------------
if (-not $ApiToken) {
    if ($env:SIGNPATH_API_TOKEN) {
        $ApiToken = $env:SIGNPATH_API_TOKEN
    } else {
        $cred = Get-Credential -UserName 'signpath' -Message 'Token API SignPath (collez le token comme mot de passe)'
        $ApiToken = $cred.GetNetworkCredential().Password
    }
}

# ---------------------------------------------------------------------------
# Module PowerShell SignPath
# ---------------------------------------------------------------------------
if (-not (Get-Module -ListAvailable -Name SignPath)) {
    Write-Host "Installation du module PowerShell SignPath..." -ForegroundColor Cyan
    Install-Module -Name SignPath -Scope CurrentUser -Force
}
Import-Module SignPath -Force

function Invoke-SignPathSigning {
    param(
        [string]$FilePath,
        [string]$Description
    )
    $tmpOut = Join-Path $env:TEMP (([IO.Path]::GetFileNameWithoutExtension($FilePath)) + '.signe' + ([IO.Path]::GetExtension($FilePath)))
    Write-Host "Signature SignPath : $Description" -ForegroundColor Cyan

    Submit-SigningRequest `
        -InputArtifactPath $FilePath `
        -ProjectSlug $ProjectSlug `
        -SigningPolicySlug $SigningPolicySlug `
        -ArtifactConfigurationSlug $ArtifactConfigurationSlug `
        -Description $Description `
        -WaitForCompletion `
        -OutputArtifactPath $tmpOut `
        -Force `
        -OrganizationId $OrganizationId `
        -ApiToken $ApiToken

    if (-not (Test-Path $tmpOut)) { throw "SignPath n'a pas renvoye d'artefact signe pour $FilePath" }
    Copy-Item -Force $tmpOut $FilePath
    Remove-Item $tmpOut
    Write-Host "  -> signe : $FilePath" -ForegroundColor Green
}

function Test-Signature {
    param([string]$FilePath)
    $sig = Get-AuthenticodeSignature -FilePath $FilePath
    [PSCustomObject]@{
        Fichier    = Split-Path -Leaf $FilePath
        Statut     = $sig.Status
        Signataire = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '(aucun)' }
    }
}

# ---------------------------------------------------------------------------
# 1-2. Signature des executables de l'application
# ---------------------------------------------------------------------------
if (-not $SkipSignAppExes) {
    Invoke-SignPathSigning -FilePath $appExe    -Description "FlyFranceVFR application $Version"
    Invoke-SignPathSigning -FilePath $bridgeExe -Description "FlyFranceVFR Bridge $Version"
}

# ---------------------------------------------------------------------------
# 3. Compilation installateur Inno Setup (contient les exes deja signes)
# ---------------------------------------------------------------------------
if (-not $SkipCompileInstaller) {
    if (-not (Test-Path $IsccPath)) { throw "ISCC introuvable : $IsccPath (ajustez -IsccPath)" }
    Write-Host "Compilation Inno Setup..." -ForegroundColor Cyan
    & $IsccPath $issFile
    if ($LASTEXITCODE -ne 0) { throw "Compilation Inno Setup echouee (code $LASTEXITCODE)" }
}

$setupExe = Join-Path $outputDir "Setup_FlyFranceVFR_v$Version.exe"
if (-not (Test-Path $setupExe)) {
    # fallback : dernier installateur produit
    $setupExe = Get-ChildItem $outputDir -Filter 'Setup_FlyFranceVFR_*.exe' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not (Test-Path $setupExe)) { throw "Installateur introuvable dans $outputDir" }

# ---------------------------------------------------------------------------
# 4. Signature de l'installateur
# ---------------------------------------------------------------------------
Invoke-SignPathSigning -FilePath $setupExe -Description "Installateur FlyFranceVFR $Version"

# ---------------------------------------------------------------------------
# 5. Verification
# ---------------------------------------------------------------------------
Write-Host "`nVerification des signatures :" -ForegroundColor Cyan
$report = @(
    Test-Signature $setupExe
    Test-Signature $appExe
    Test-Signature $bridgeExe
)
$report | Format-Table -AutoSize

$echecs = $report | Where-Object { $_.Statut -ne 'Valid' }
if ($echecs) {
    throw "Des signatures sont invalides ou absentes (voir tableau ci-dessus)."
}
Write-Host "Toutes les signatures sont valides." -ForegroundColor Green
Write-Host "Installateur signe : $setupExe"
