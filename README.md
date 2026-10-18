# Secure Session Launcher

A Chrome extension that lets a web portal open business applications in their own browser windows and
manage those sessions safely:

- open each application in its own **normal or incognito window**;
- notice when an application is **already open**, and ask the user what to do, or close it and start again;
- close an application **without "Leave site?" prompts** and **clear its sign-in data** (cookies, including
  parent domains, plus localStorage, IndexedDB, caches and service workers), so the next user or account
  starts at the login page;
- give every launch a **fresh start**, even after the user closed the previous window themselves;
- **clean up at sign-out:** close every application window the portal opened and clear their sign-in data;
- tell the portal **which of its application windows is in front**, with the portal's own data for that
  window (for example to switch a sign-on agent to the right account).

It is not tied to any sign-on product. Customers of i-Sprint AccessMatrix Universal Sign-On (USO) can use it
with i-Sprint's USO integration library to keep USOClient on the right account for each window.

## How it fits into your web application

Your portal talks to the extension with `window.postMessage`. No extension ID, no server change, and nothing
in the applications you launch.

```html
<meta name="secure-session-launcher" content="portal">
<script src="secure-session-launcher.js"></script>
<script>
  // When the user clicks an application:
  SessionLauncher.launch({ url: 'https://crm.example.com/login', app: 'crm' })
    .then(r => console.log(r.outcome))             // 'opened', 'confirming' or 'closing'
    .catch(e => console.warn(e.code, e.message));  // e.g. 'no-extension', 'not-approved'

  // When the user signs out of your portal:
  SessionLauncher.prepareSignOut()
    .then(() => SessionLauncher.finishSignOut())   // closes the windows, clears their sign-in data
    .finally(() => location.href = '/signed-out');
</script>
```

The extension acts only for sites the user (or their organisation) has **approved**. Give your portal an
"Approve" button that calls `SessionLauncher.requestApproval()`; users can also approve a portal from the
extension's toolbar icon. The extension never asks on its own.

Read the **[developer guide](docs/DEVELOPER-GUIDE.md)** for the full interface: launch options, what "already
open" means, window events, sign-out, Chrome policies for organisations, and error codes.

## Repository

| Path | Contents |
|---|---|
| [extension/](extension/) | The extension (Manifest V3) |
| [client/secure-session-launcher.js](client/secure-session-launcher.js) | Client script for your portal pages (global `SessionLauncher`, or CommonJS / AMD) |
| [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) | How to integrate the extension in a web application |
| [examples/](examples/) | A working example portal |
| [PRIVACY.md](PRIVACY.md) | What the extension stores, and that it sends nothing anywhere |
| [CHANGELOG.md](CHANGELOG.md) | Versions |

## Try it

1. **Install the extension:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
   and choose the `extension` folder.
2. **Run the example portal:** from the repository folder, start any local web server, for example
   `python -m http.server 8000` (any free port), then open `http://localhost:8000/examples/portal.html`.
3. Click **Check extension**, then **Approve this portal**, then launch the example applications.

See [examples/README.md](examples/README.md) for what each button shows.

To package the extension as a zip (for example for the Chrome Web Store), run `scripts/build-zip.ps1` on
Windows, or `cd extension && zip -r ../secure-session-launcher.zip .` elsewhere.

## Permissions

| Permission | Used to |
|---|---|
| `tabs` | Find whether a launched application is already open; open and close application windows |
| `scripting` | Switch off an application page's "Leave site?" prompt just before closing a window the user chose to close |
| `cookies` | Clear the sign-in cookies of an application being closed or signed out of |
| `browsingData` | Clear that application's localStorage, IndexedDB, caches and service workers |
| `storage` | Remember approved portals, launched windows and the sites to clean up, in the browser only |
| Access to `http://*/*` and `https://*/*` | Applications can be on any site; the extension clears their data and receives requests from approved portal pages |

The extension acts only on requests from approved portal pages that carry the marker tag, and only on the
windows and sites those portals launched. It sends nothing to any server; see [PRIVACY.md](PRIVACY.md).

## Requirements

- Google Chrome, or another Chromium browser with Manifest V3 extensions.
- Portal pages served over HTTPS (or from `localhost` during development).
- For incognito windows: "Allow in Incognito" turned on for the extension in `chrome://extensions`.
