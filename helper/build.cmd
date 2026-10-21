@echo off
:: Compiles SecureSessionHelper.exe with the C# compiler of .NET Framework 4 (part of Windows; no SDK needed).
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -nologo -target:winexe -r:System.Web.Extensions.dll -out:"%~dp0SecureSessionHelper.exe" "%~dp0SecureSessionHelper.cs"
if errorlevel 1 (echo Build failed.) else (echo Built SecureSessionHelper.exe. Next: install.cmd)
pause
