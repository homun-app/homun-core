<#
.SYNOPSIS
  Headless login to Certum SimplySign Desktop on a Windows CI runner, so signtool
  (or electron-builder's certificateSubjectName) can sign using the cloud cert.

.DESCRIPTION
  SimplySign has no CLI login: after entering the login (email) + a TOTP one-time code, the
  Desktop app exposes the certificate to the Windows certificate store (CryptoAPI),
  where signtool picks it up. This script:
    1. reads the otpauth:// secret from $env:SIMPLYSIGN_TOTP_SEED (Base32),
    2. generates the current TOTP (SHA256, 6 digits, 30s period — Certum's params),
    3. starts SimplySign Desktop and drives its login dialog with SendKeys,
    4. waits for the virtual smart card / cert to appear in the store.

  ⚠️ The SendKeys section is inherently fragile GUI automation (window titles, field
  order, and timings differ across SimplySign versions). It MUST be tuned against a
  real CI run — capture a screenshot on failure (see the workflow) and adjust the
  window title match, the number of TABs, and the Start-Sleep values below.

.NOTES
  Secrets expected in the environment (never echoed):
    SIMPLYSIGN_TOTP_SEED  Base32 TOTP secret (from the setup QR's otpauth:// URI)
    SIMPLYSIGN_LOGIN      SimplySign login (email)
    SIMPLYSIGN_PIN        card PIN (used by signtool at sign time, not here)
#>
[CmdletBinding()]
param(
  # Full path to the SimplySign Desktop executable, once installed on the runner.
  [string]$SimplySignExe = "C:\Program Files\Certum\SimplySign Desktop\SimplySignDesktop.exe",
  # How long to wait for the certificate to land in the store after login (seconds).
  [int]$CertWaitSeconds = 60
)

$ErrorActionPreference = "Stop"

function Get-Totp {
  <# RFC 6238 TOTP. Certum uses SHA256 / 6 digits / 30s (NOT the SHA1 default). #>
  param([Parameter(Mandatory)][string]$Base32Secret,
        [int]$Digits = 6, [int]$Period = 30, [string]$Algo = "SHA256")

  # Base32 decode (RFC 4648, no padding needed).
  $alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  $bits = ""
  foreach ($c in $Base32Secret.ToUpper().ToCharArray()) {
    $idx = $alphabet.IndexOf($c)
    if ($idx -lt 0) { continue }
    $bits += [Convert]::ToString($idx, 2).PadLeft(5, '0')
  }
  $bytes = New-Object System.Collections.Generic.List[byte]
  for ($i = 0; $i + 8 -le $bits.Length; $i += 8) {
    $bytes.Add([Convert]::ToByte($bits.Substring($i, 8), 2))
  }
  $key = $bytes.ToArray()

  # Counter = floor(unixtime / period), 8-byte big-endian.
  $unix = [long][Math]::Floor((New-TimeSpan -Start (Get-Date "1970-01-01Z").ToUniversalTime() -End (Get-Date).ToUniversalTime()).TotalSeconds)
  $counter = [long][Math]::Floor($unix / $Period)
  $counterBytes = [BitConverter]::GetBytes($counter)
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($counterBytes) }

  $hmac = switch ($Algo) {
    "SHA256" { New-Object System.Security.Cryptography.HMACSHA256 }
    "SHA1"   { New-Object System.Security.Cryptography.HMACSHA1 }
    "SHA512" { New-Object System.Security.Cryptography.HMACSHA512 }
    default  { throw "Unsupported TOTP algorithm: $Algo" }
  }
  $hmac.Key = $key
  $hash = $hmac.ComputeHash($counterBytes)

  # Dynamic truncation (RFC 4226).
  $offset = $hash[$hash.Length - 1] -band 0x0f
  $binary = (($hash[$offset]   -band 0x7f) -shl 24) -bor
            (($hash[$offset+1] -band 0xff) -shl 16) -bor
            (($hash[$offset+2] -band 0xff) -shl 8)  -bor
             ($hash[$offset+3] -band 0xff)
  $otp = $binary % [Math]::Pow(10, $Digits)
  return ([string]$otp).PadLeft($Digits, '0')
}

# --- 1. Read secrets (fail loudly if missing; never print their values) ---
$seed    = $env:SIMPLYSIGN_TOTP_SEED
$login = $env:SIMPLYSIGN_LOGIN
if ([string]::IsNullOrWhiteSpace($seed))    { throw "SIMPLYSIGN_TOTP_SEED is not set" }
if ([string]::IsNullOrWhiteSpace($login)) { throw "SIMPLYSIGN_LOGIN is not set" }

$otp = Get-Totp -Base32Secret $seed
Write-Host "Generated OTP (length $($otp.Length)) — value not shown."

# --- 2. Locate + start SimplySign Desktop ---
# The installer path varies (publisher is Asseco). If the assumed path is wrong, search
# the usual install roots; if still not found, dump the vendor folders and fail loudly so
# the exact path can be pinned from the CI log.
if (-not (Test-Path $SimplySignExe)) {
  $roots = @("$env:ProgramFiles", "${env:ProgramFiles(x86)}", "$env:LOCALAPPDATA", "$env:APPDATA") |
           Where-Object { $_ -and (Test-Path $_) }
  $hit = Get-ChildItem -Path $roots -Recurse -Depth 4 -Filter "SimplySignDesktop.exe" -ErrorAction SilentlyContinue |
         Select-Object -First 1
  if (-not $hit) {
    $hit = Get-ChildItem -Path $roots -Recurse -Depth 4 -Filter "*SimplySign*.exe" -ErrorAction SilentlyContinue |
           Select-Object -First 1
  }
  if ($hit) { $SimplySignExe = $hit.FullName }
}
if (-not (Test-Path $SimplySignExe)) {
  Write-Host "=== SimplySign exe not found. Vendor folders + .exe under Program Files: ==="
  Get-ChildItem "$env:ProgramFiles", "${env:ProgramFiles(x86)}" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "Certum|Asseco|SimplySign|proCertum|pcert" } |
    ForEach-Object {
      Write-Host "-- $($_.FullName)"
      Get-ChildItem $_.FullName -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 20 -ExpandProperty FullName | ForEach-Object { Write-Host "   $_" }
    }
  throw "SimplySign Desktop executable not found after install (see listing above)."
}
Write-Host "SimplySign Desktop exe: $SimplySignExe"
# The installer often auto-launches it; only start a new instance if none is running.
if (-not (Get-Process -Name "SimplySignDesktop" -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $SimplySignExe | Out-Null
}
Start-Sleep -Seconds 8   # TODO(ci): tune — wait for the tray app + login window.

# --- 3. Drive the login dialog (FRAGILE — tune against a real run) ---
Add-Type -AssemblyName System.Windows.Forms
$wshell = New-Object -ComObject WScript.Shell

# TODO(ci): confirm the exact window title. Screenshot on failure and adjust.
$null = $wshell.AppActivate("SimplySign")
Start-Sleep -Seconds 2

# TODO(ci): confirm field order. Typical: [login email] TAB [OTP] ENTER.
$wshell.SendKeys($login)
Start-Sleep -Milliseconds 500
$wshell.SendKeys("{TAB}")
Start-Sleep -Milliseconds 500
$wshell.SendKeys($otp)
Start-Sleep -Milliseconds 500
$wshell.SendKeys("{ENTER}")

# TODO(ci): certum-container notes a "press close to ACTIVATE the token" step after
# login. If the cert never appears below, add the extra activation keystroke here.
Start-Sleep -Seconds 6

# --- 4. Wait for the code-signing cert to appear in the store ---
$deadline = (Get-Date).AddSeconds($CertWaitSeconds)
$found = $null
while ((Get-Date) -lt $deadline) {
  $found = Get-ChildItem Cert:\CurrentUser\My |
           Where-Object { $_.Subject -like "*Open Source Developer Fabio Cantone*" -and $_.HasPrivateKey }
  if ($found) { break }
  Start-Sleep -Seconds 3
}
if (-not $found) {
  throw "Certificate did not appear in Cert:\CurrentUser\My within $CertWaitSeconds s — login/activation likely failed (see screenshot)."
}
Write-Host "Certificate present in store: $($found.Thumbprint)"
# Export the thumbprint for the signing step.
"THUMBPRINT=$($found.Thumbprint)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
