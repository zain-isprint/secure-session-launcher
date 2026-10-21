# Installs Secure Session Helper for the current Windows user (no administrator rights needed).
# Registers it with Google Chrome and Microsoft Edge as the native messaging host com.isprint.ssl.parallel, allowed
# only for the Secure Session Launcher builds listed below.
$ErrorActionPreference = "Stop"
$Name = "com.isprint.ssl.parallel"
$Dest = Join-Path $env:LOCALAPPDATA "SecureSessionHelper"
$Ids  = @(
    "mbbaaodhkbilnbmpgbolecjdjkpinmjd"    # Secure Session Launcher loaded from this repository (ID fixed by the manifest key)
    # Add the ID of your own packed or store build here.
)
$Exe = Join-Path $PSScriptRoot "SecureSessionHelper.exe"
if (!(Test-Path $Exe)) { throw "SecureSessionHelper.exe not found: run build.cmd first." }
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
Copy-Item $Exe -Destination $Dest -Force
$Manifest = Join-Path $Dest "$Name.json"
@{
    name = $Name
    description = "Secure Session Helper: opens applications in isolated browser sessions"
    path = (Join-Path $Dest "SecureSessionHelper.exe")
    type = "stdio"
    allowed_origins = @($Ids | ForEach-Object { "chrome-extension://$_/" })
} | ConvertTo-Json | Set-Content -Path $Manifest -Encoding ASCII
foreach ($Key in @("HKCU:\Software\Google\Chrome\NativeMessagingHosts\$Name", "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$Name")) {
    New-Item -Path $Key -Force | Out-Null
    Set-ItemProperty -Path $Key -Name "(Default)" -Value $Manifest
}
Write-Host "Secure Session Helper installed in $Dest." -ForegroundColor Green
Write-Host "Reload your portal page: the 'separate browser' option is now available." -ForegroundColor Green
