# Secure Session Helper

> **Experimental.** Optional Windows companion of Secure Session Launcher (1.0.3 or later). Provided as is,
> not code-signed. Build it yourself from the source in this folder.

Secure Session Helper lets Secure Session Launcher open an application in a **separate browser window with its own
cookies and storage**: the confirmation page's **Open parallel session in a separate browser**. A user can then work
in two accounts of the same application side by side, in normal (not incognito) windows, and any number of them.

A browser extension cannot start another browser profile itself. The helper is the small Windows program that does
it, when the extension asks (Chrome and Edge "native messaging").

## Requirements

| Item | Requirement |
|---|---|
| Windows | Windows 10 or 11, with .NET Framework 4 (included in Windows) |
| Browser | Google Chrome or Microsoft Edge. The separate window opens in the same browser as the launcher that asked for it. |
| Secure Session Launcher | 1.0.3 or later, loaded from this repository's `extension` folder (its manifest `key` gives it the ID `mbbaaodhkbilnbmpgbolecjdjkpinmjd`, which `install.ps1` allows) |
| Extensions in the separate window | Each separate window is its own browser profile. Extensions your applications need there (for example a sign-on agent's extension) must be installed for every profile, normally by your organisation with the `ExtensionInstallForcelist` policy (Chrome and Edge have separate policies). |
| Rights | None: the helper installs and runs as the user |

## Build and install

1. Run **`build.cmd`**. It compiles `SecureSessionHelper.cs` into `SecureSessionHelper.exe` with the C# compiler
   that comes with .NET Framework 4; no SDK is needed.
2. Run **`install.cmd`** (no administrator prompt). It installs the helper for the current Windows user.
3. Reload your portal page. `SessionLauncher.hello()` now returns `separateBrowserAvailable: true`, and the
   confirmation page's **separate browser** button is enabled.

To remove it, run **`uninstall.cmd`** (close any separate-browser windows first).

## What it changes on the PC

`install.ps1` does three things and exits. Nothing keeps running; there is no service, start-up entry, scheduled task
or firewall rule.

| Change | Where |
|---|---|
| Copies the program | `%LOCALAPPDATA%\SecureSessionHelper\SecureSessionHelper.exe` |
| Writes its native messaging manifest (name, program path, the extension IDs allowed to start it) | `%LOCALAPPDATA%\SecureSessionHelper\com.isprint.ssl.parallel.json` |
| Registers it for this user with Chrome and Edge | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.isprint.ssl.parallel` and `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.isprint.ssl.parallel` |

When used, the helper creates reusable isolated profiles (`%LOCALAPPDATA%\SecureSessionLauncher\profiles\parallel-1`
… `parallel-9`, and `profiles-edge\...` for Edge), the list of open sessions (`isolated-sessions.json`) and logs
(`host.log`, `isolated.log`) in the same folder. `uninstall.ps1` removes the registry entries and both folders.

## How it works

The browser starts the helper only when Secure Session Launcher sends it a request, and only if the extension's ID is
in the manifest's `allowed_origins`. Messages are small JSON objects over the program's standard input and output;
nothing goes over the network.

| Request | When | Effect |
|---|---|---|
| `ping` | The confirmation page opens (cached 30 s) | Answers with the helper's version |
| `open` (URL, portal, browser, waitFor) | The user chooses **separate browser** | Starts an isolated session (below) and answers at once |
| `watch` | While separate windows are open | Reports which window is in front |
| `list` | A launch, while separate sessions are recorded | The sessions whose windows are still open |
| `closeSession` (session IDs) | **Close active session & continue** for an application open in a separate window | Closes those windows and clears their sign-in data |
| `closeSessions` (portal) | The user signs out of that portal | Closes that portal's separate windows and clears their sign-in data |

**Opening.** The helper starts a second copy of itself for the session, which picks an isolated profile not in use,
deletes its sign-in data (cookies, local storage, IndexedDB, session storage, service workers, caches, saved
sessions; extensions and settings are kept), starts the browser with that profile (`--user-data-dir`), and records
the session. For Edge it also passes `--disable-features=msImplicitSignin --disable-sync`; otherwise Edge signs a new
profile in to the Windows Microsoft account and syncs the user's extensions, favorites and passwords into it.

**Waiting for a sign-on agent (optional).** With `separateBrowser: { waitFor: 'uso' }` in the launch request, the
window first shows a short "Preparing a separate session" page, served by the helper on `127.0.0.1` on a random
port, which waits until the i-Sprint USO Chrome extension is active in that window, then opens the application.
Without it, the window opens the application at once.

**Window in front.** The browser does not tell an extension about windows of another browser instance. While separate
windows are open, the launcher keeps one helper process with `watch`; it checks the foreground window about every
0.15 s (about 1% of one CPU core) and reports a separate window, or a normal browser window, coming to the front. The
portal receives the usual `window.focused` events, with the `app` and `data` given at launch.

**Closing.** The helper asks each window to close as the user would; if one is still open after 8 seconds (for
example a page asking "Leave site?"), it is closed by force. It then deletes that profile's sign-in data.

## Security

| Topic | Design |
|---|---|
| Who can start it | Only the extension IDs in the manifest's `allowed_origins`. Web pages and other extensions cannot. |
| What it accepts | Fixed requests. `open` accepts only an `http` or `https` address; the helper chooses every folder and command itself. |
| Network | No listening port, except the optional waiting page: `127.0.0.1` only, a random port, for a few seconds per session. |
| Credentials | None pass through it. |
| Data at rest | Sign-in data in the isolated profiles is deleted when a session is closed, and before each reuse. Logs contain application addresses and process IDs. |
| Rights | Runs as the user; installs under the user's own folders and registry. |
| Code signing | Not signed. Windows SmartScreen or antivirus may warn about a program you build yourself. |

## Deploying to many PCs

1. Build `SecureSessionHelper.exe`, sign it with your organisation's code-signing certificate, and copy it with the
   manifest JSON to a protected folder, for example `C:\Program Files\SecureSessionHelper\`; set `path` in the JSON
   to the program there.
2. Register it machine-wide: `HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.isprint.ssl.parallel` and
   `HKLM\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.isprint.ssl.parallel`, default value = the JSON file's path.
3. If you deploy Secure Session Launcher under another ID (packed with your own key, or from a store), put that ID in
   `allowed_origins` (in `install.ps1`, or in the JSON file).
4. Force-install Secure Session Launcher and any extensions your applications need for every profile
   (`ExtensionInstallForcelist`), so the separate windows need no set-up.

## Troubleshooting

| Symptom | Check |
|---|---|
| The **separate browser** button is greyed out | The helper is not installed for this Windows user, or the launcher's ID is not in `allowed_origins`. Run `install.cmd`, then reload the portal page (the launcher re-checks after 30 s). |
| The window stays on "Preparing a separate session" | Only with `waitFor: 'uso'`: the USO Chrome extension is not active in that window. Install it for every profile, or add it in that window. |
| "Microsoft Edge was not found" / "Google Chrome was not found" | The helper looks in the browser's usual install folders and Windows' App Paths. |
| A separate window opens already signed in | Its sign-in data could not be deleted (files in use). Close all separate windows and try again. |
| "No free profile" in `isolated.log` | Nine separate sessions are already open for that browser. |

Logs: `%LOCALAPPDATA%\SecureSessionLauncher\host.log` and `isolated.log`.

## Limitations

- Windows only; Chrome and Edge.
- Up to nine separate sessions at a time per user and browser. Each is a whole browser instance (about 100–200 MB).
- Clearing sign-in data relies on the names of Chromium's profile files, which a browser update may change.
- If the browser or the PC stops abruptly, sign-in data stays in the profile until its next use (it is cleared then).
