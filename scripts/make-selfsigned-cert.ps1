<#
.SYNOPSIS
  Generate a throwaway self-signed Authenticode certificate for local signed
  builds, exported as a .pfx.

.DESCRIPTION
  Real SmartScreen/Norton trust needs a purchased cert (or Azure Trusted
  Signing). This produces a self-signed cert so the signing pipeline can be
  exercised today: signed builds verify locally if you trust the cert, but
  recipients still see SmartScreen warnings (an untrusted publisher).

  Signing is env-var driven, so swapping in a real cert later is just changing
  CSC_LINK / CSC_KEY_PASSWORD (no code change):

      $env:CSC_LINK        = "certs/code-signing.pfx"
      $env:CSC_KEY_PASSWORD = "reel-editor-dev"
      npm run build:win

.PARAMETER Password
  Password for the exported .pfx (and CSC_KEY_PASSWORD). Defaults to a known dev
  value since the cert is a disposable self-signed one.

.PARAMETER Out
  Output .pfx path. Defaults to certs/code-signing.pfx (gitignored).
#>
param(
  [string]$Password = "reel-editor-dev",
  [string]$Out = "certs/code-signing.pfx"
)

$ErrorActionPreference = "Stop"

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

Write-Host "Generating self-signed code-signing certificate..."
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=Reel Editor (Self-Signed Dev)" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(5)

$secure = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $Out -Password $secure | Out-Null

Write-Host "Wrote $Out  (thumbprint $($cert.Thumbprint))"
Write-Host ""
Write-Host "To build a signed installer, set these then run npm run build:win:"
Write-Host "  `$env:CSC_LINK = `"$Out`""
Write-Host "  `$env:CSC_KEY_PASSWORD = `"$Password`""
Write-Host ""
Write-Host "Optional, to make THIS machine trust the self-signed publisher (so the"
Write-Host "installer shows a known publisher locally) run as admin:"
Write-Host "  Import-PfxCertificate -FilePath `"$Out`" -CertStoreLocation Cert:\LocalMachine\TrustedPublisher -Password (ConvertTo-SecureString '$Password' -AsPlainText -Force)"
