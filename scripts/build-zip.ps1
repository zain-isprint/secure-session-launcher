$ErrorActionPreference = "Stop"
# Packages extension\ as secure-session-launcher-<version>.zip in the repository folder, for the Chrome Web
# Store or for distribution. Entries are named with "/" (icons/icon16.png), as Chrome expects; Windows
# PowerShell's Compress-Archive writes "\".
$Root = Split-Path $PSScriptRoot -Parent
$Extension = Join-Path $Root "extension"
$Version = (Get-Content (Join-Path $Extension "manifest.json") -Raw | ConvertFrom-Json).version
$Zip = Join-Path $Root "secure-session-launcher-$Version.zip"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $Zip) { Remove-Item $Zip -Force }
$Archive = [System.IO.Compression.ZipFile]::Open($Zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $Base = (Resolve-Path $Extension).Path.TrimEnd('\') + '\'
    foreach ($File in Get-ChildItem -Path $Extension -File -Recurse) {
        $Name = $File.FullName.Substring($Base.Length).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Archive, $File.FullName, $Name) | Out-Null
    }
} finally { $Archive.Dispose() }
Write-Host "Created $Zip"
