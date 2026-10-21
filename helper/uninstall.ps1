# Removes Secure Session Helper for the current Windows user, with its isolated profiles and logs.
$Name = "com.isprint.ssl.parallel"
foreach ($Key in @("HKCU:\Software\Google\Chrome\NativeMessagingHosts\$Name", "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$Name")) {
    if (Test-Path $Key) { Remove-Item -Path $Key -Recurse -Force }
}
foreach ($Dir in @((Join-Path $env:LOCALAPPDATA "SecureSessionHelper"), (Join-Path $env:LOCALAPPDATA "SecureSessionLauncher"))) {
    if (Test-Path $Dir) { Remove-Item -Path $Dir -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host "Secure Session Helper removed. Close any separate-browser windows first if some files were in use." -ForegroundColor Green
