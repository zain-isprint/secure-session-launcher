# Secure Session Launcher: developer guide

How to use the Secure Session Launcher Chrome extension from your web application (the "portal") to
open applications in their own windows and manage their sessions.

Interface version **1.0**.

## Contents

1. [How it works](#1-how-it-works)
2. [Set up your pages](#2-set-up-your-pages)
3. [Sending requests](#3-sending-requests)
4. [Detect the extension and get approved](#4-detect-the-extension-and-get-approved)
5. [Launch an application](#5-launch-an-application)
6. [Follow the application window in front](#6-follow-the-application-window-in-front)
7. [Sign-out](#7-sign-out)
8. [Deploying to an organisation](#8-deploying-to-an-organisation)
9. [Using it with a sign-on agent](#9-using-it-with-a-sign-on-agent)
10. [Security notes](#10-security-notes)
11. [Troubleshooting](#11-troubleshooting)
12. [Reference](#12-reference)

## 1. How it works

```
 Your portal page                    Secure Session Launcher                 Application windows
 ----------------                    -----------------------                 -------------------
 window.postMessage(request)  --->   checks the page is approved
                                     opens / closes windows        --->      app.example.com (own window)
                                     clears cookies and storage              crm.example.com (incognito)
 window "message" event       <---   results, and "window focused" events
```

- Your pages talk to the extension with `window.postMessage`. No extension ID and no server change are
  needed; [`client/secure-session-launcher.js`](../client/secure-session-launcher.js) wraps the messages
  (section 3).
- The extension accepts requests only from pages you mark (section 2), and only from sites the user or
  their organisation has approved (section 4).
- The extension is not tied to any sign-on product. Each launch can carry your own data; the extension
  hands it back when that window comes to the front, and your page decides what to do with it, for
  example switching a sign-on agent to the right account (section 6).
- Requests never carry passwords. The extension never reads or changes your application pages, except
  to switch off a "Leave site?" prompt on a window it is about to close.

## 2. Set up your pages

Add a marker to every portal page that talks to the extension:

```html
<meta name="secure-session-launcher" content="portal">
```

| `content` | Use on | Allows |
|---|---|---|
| `portal` | The page the user stays on, for example your application list | All requests and events |
| `launch` | A page that only launches one application and may then close | `hello`, `requestApproval`, `launch` |

Requests from a page without the marker are ignored. Pages must be served over HTTPS (or from
`localhost` during development).

## 3. Sending requests

Each request is a message posted to the page's own window, with your origin as the target:

```js
window.postMessage({
  channel: 'secure-session-launcher',
  type: 'launch',                      // what to do (section 12)
  requestId: 'r-1712345678',           // your ID; it comes back in the reply
  // ...fields for this type
}, location.origin);
```

The extension answers with a message on the same window:

```js
{ channel: 'secure-session-launcher', type: 'launch.result', requestId: 'r-1712345678', ok: true, /* results */ }
{ channel: 'secure-session-launcher', type: 'launch.result', requestId: 'r-1712345678', ok: false,
  error: { code: 'not-approved', message: 'Readable text for the user' } }
```

Events (section 6) arrive the same way, with `type: 'event'` and no `requestId`.

If the extension is not installed, nothing answers, so always use a timeout. The client script
[`client/secure-session-launcher.js`](../client/secure-session-launcher.js) does both; its core is shown here:

```js
var SessionLauncher = (function () {
  var CHANNEL = 'secure-session-launcher';
  var listeners = {};
  window.addEventListener('message', function (event) {
    var d = event.data;
    if (event.source !== window || event.origin !== location.origin || !d || d.channel !== CHANNEL || d.type !== 'event') return;
    (listeners[d.event] || []).forEach(function (fn) { fn(d); });
  });
  function request(type, fields, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var requestId = type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      var timer = setTimeout(function () {
        window.removeEventListener('message', onReply);
        reject(Object.assign(new Error('Secure Session Launcher did not answer. Is it installed and enabled?'), { code: 'no-extension' }));
      }, timeoutMs || 3000);
      function onReply(event) {
        var d = event.data;
        if (event.source !== window || event.origin !== location.origin || !d || d.channel !== CHANNEL
            || d.requestId !== requestId || d.type !== type + '.result') return;
        clearTimeout(timer);
        window.removeEventListener('message', onReply);
        if (d.ok) resolve(d);
        else reject(Object.assign(new Error(d.error && d.error.message || 'Request failed'), { code: d.error && d.error.code }));
      }
      window.addEventListener('message', onReply);
      window.postMessage(Object.assign({ channel: CHANNEL, type: type, requestId: requestId }, fields || {}), location.origin);
    });
  }
  return {
    hello: function () { return request('hello', {}, 2000); },
    requestApproval: function () { return request('requestApproval', {}, 120000); },
    launch: function (options) { return request('launch', options, 15000); },
    subscribe: function (events) { return request('events.subscribe', { events: events }, 2000); },
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    windowInFront: function () { return request('windows.front', {}, 2000); },
    prepareSignOut: function () { return request('signOut.prepare', {}, 2000); },
    finishSignOut: function () { return request('signOut.finish', {}, 15000); }
  };
})();
```

The rest of this guide uses `SessionLauncher`.

## 4. Detect the extension and get approved

Call `hello` when the portal page loads. The extension's content script starts with the page, but an
answer to the very first request is not guaranteed; retry once after 300 ms if it times out.

```js
SessionLauncher.hello().then(function (info) {
  // info.version            e.g. "1.0.0"
  // info.approved           true when this site is approved
  // info.incognitoAllowed   true when "Allow in Incognito" is on for the extension
  // info.separateBrowserAvailable  true when the optional Secure Session Helper is installed (1.0.3)
  if (isOlder(info.version, MIN_VERSION)) showUpdateNotice();
  if (!info.approved) showApproveButton();   // the button calls SessionLauncher.requestApproval()
}).catch(function (e) {
  if (e.code === 'no-extension') showInstallLink();
});
```

**Approval.** The extension acts only for approved sites (origins such as `https://portal.example.com`).
It never asks on its own: a site that is not approved simply gets `not-approved`. A site is approved in
one of three ways:

- **your portal's button (recommended):** give your page a button, for example "Approve this portal in
  Secure Session Launcher", that calls `requestApproval`. It opens an extension page asking "Allow
  portal.example.com to manage application windows?". It resolves with `{ approved: true }` or rejects
  with `not-approved`. Call it only from a click, so the user knows why it appears. Show the button only
  while `hello` reports `approved: false`.
- **the extension's toolbar icon:** on a page carrying the marker (section 2), the user clicks the
  Secure Session Launcher icon and chooses **Allow this site**. The extension then reloads the page, so
  your page sees `approved: true` when it calls `hello` again. Pages without the marker cannot be approved
  this way.
- **the organisation:** a Chrome policy lists the approved sites (section 8). Users are then never asked.

Users can see and remove approvals from the toolbar icon (for the current site) and on the extension's
options page.

## 5. Launch an application

```js
SessionLauncher.launch({
  url: 'https://app.example.com/login',   // required: http or https
  app: 'crm',                              // your ID for the application (recommended)
  data: { account: 'ID3' },                // your data for this window (optional), see section 6
  ifOpen: 'ask',                           // 'ask' (default) or 'close'
  window: 'normal',                        // 'normal' (default) or 'incognito'
  closeRequestingTab: false                // true: close the page that sent this request
}).then(function (r) {
  // r.outcome: 'opened'     the application window is open
  //            'confirming' it was already open; the user is choosing on the extension's page
  //            'closing'    it was already open; the old window is closing, then the new one opens
}).catch(function (e) {
  // e.code: 'not-approved', 'incognito-not-allowed', 'invalid-request'
});
```

Call `launch` from a user action (a click). Browsers may otherwise block the new window, and users
expect a window to open only when they ask for one.

### Fields

| Field | Required | Description |
|---|---|---|
| `url` | Yes | The application's address. Anything after `#` is kept and passed to the application. |
| `app` | No | Your ID for the application. Windows launched with the same `app` on the same site count as "already open", wherever the user has navigated since. |
| `data` | No | Any JSON value, up to 4 KB. The extension keeps it with the window and returns it unchanged in events and `windows.front`. It never interprets it. Do not put secrets in it. |
| `ifOpen` | No | What to do when the application is already open: `ask` shows the extension's confirmation page; `close` closes the open window and continues without asking. |
| `window` | No | `incognito` opens the application with its own cookies and storage. Needs "Allow in Incognito" for the extension. |
| `closeRequestingTab` | No | `true` for a separate launch page that should disappear once the application opens. |
| `separateBrowser` | No | Options for "Open parallel session in a separate browser". `{ waitFor: 'uso' }`: the separate window first waits until the i-Sprint USO Chrome extension is active in it, then opens the application (otherwise it opens the application at once). (1.0.6) |
| `parallel` | No | With `ifOpen: 'ask'`: the choices the confirmation page offers besides "Close active session & continue" and "Cancel launch" (always shown). A list of `shared` (Continue without closing), `incognito` and `separate` (separate browser); `[]` offers neither. Default: all three, or the `defaultParallel` policy. A choice not offered is refused even if requested. (1.0.5) |

### A fresh start for every launch

When the application is not open, the extension first clears its site's sign-in data (the cookies and
stored data described below), so the application always starts at its login page. Otherwise a window the
user closed with X, or a Chrome restart, would leave the previous account signed in, and a launch with
another account would open as the previous one.

Nothing is cleared while any tab on the application's host is open, including tabs the extension did not
launch, so the user is never signed out of a site they are using. Cookies your portal's host also receives
are always kept.

### When is an application "already open"?

The extension looks for, in normal and incognito windows:

1. a window it launched for the same `app` that is still on the same site (scheme, host and port), even
   if the user has moved to another page there. For example, `github.com/login` becomes `github.com/`
   after sign-in;
2. any tab at exactly the same address, ignoring `?query` and `#fragment`.

A tab on the same site but at another address, which the extension did not launch, does not count.

### What the user sees with `ifOpen: 'ask'`

The extension opens its "Conflicting Session Detected" page. It lists the open windows and offers:

| Choice | Effect |
|---|---|
| Close active session & continue | Closes the open windows without "Leave site?" prompts, clears the site's cookies and stored data, then opens the application in the `window` mode you asked for. Windows of the application in a separate browser are closed too (1.0.4). |
| Continue without closing | Keeps the open window and opens the application again in another normal window. It shares cookies with the open one, so most applications open already signed in as the same user: a second window of the same account, not another account. Shown in a different colour (amber) for that reason. Before 1.0.5: "Open parallel session". |
| Open parallel session in incognito | Opens the application with its own cookies and storage, at its login page. All incognito windows share one session. Disabled when "Allow in Incognito" is off. |
| Open parallel session in a separate browser | Opens the application in a separate window of the same browser (Chrome or Edge) with an isolated profile of its own: its own cookies, at its login page, in a normal window, and any number of them. Needs the optional Secure Session Helper (a small Windows program, see [helper/](../helper/)); disabled without it. These windows produce `window.focused` events like the others and are closed by `signOut.finish`. |
| Cancel launch | Does nothing. |

`ifOpen: 'close'` does the first choice without asking. The new window gets the `app` and `data` of
this launch.

### What "clear the site's data" means

For the application's host (for `login.example.com`):

- **Cookies:** those of `login.example.com` and its parent domains (`.example.com`), in normal and
  incognito windows. Cookies that **your portal's host also receives are always kept**, so your users
  stay signed in to the portal. Cookies of other subdomains (`api.example.com`) are kept.
- **Stored data:** localStorage, IndexedDB, Cache Storage and service workers of the application's exact
  origin.

If your portal and an application share a parent domain, keep the portal's session cookie on the
portal's own host or on that shared parent domain. Either way the extension will not clear it.

## 6. Follow the application window in front

Your portal page can be told when the user brings one of the application windows it launched to the
front. A typical use is a sign-on agent that fills logins with one account at a time: when the user
moves to a window, the portal switches the agent to that window's account (section 9).

**Subscribe** once, from the page marked `portal`:

```js
SessionLauncher.on('window.focused', function (e) {
  // e.app        the app ID given at launch
  // e.data       the data given at launch, unchanged
  // e.incognito  true for an incognito window
  // e.window     an opaque ID for the window, the same for every event about it
  switchAgentTo(e.data);
});
SessionLauncher.subscribe(['window.focused']);
```

| Rule | Detail |
|---|---|
| When | The user switches to a tab, or to a window whose active tab, was launched from your portal. Rapid switching is settled for 300 ms first, so only the window the user stays on is reported. |
| Not sent | For windows being closed by the extension, for tabs launched from another portal, and for tabs the extension did not launch. |
| Repeats | An event is sent every time such a window comes to the front, even if it was the last one reported. Ignore repeats in your page if they do not matter to you. |
| Receiver | The most recent page of your origin that subscribed. Subscribe from one page only, typically the portal. Subscribing again (for example after a reload) takes over. |
| Lifetime | Until the subscribing page is closed or navigates away. |

**Which window is in front now?** Use `windows.front`, for example when your page loads or before a
periodic task:

```js
SessionLauncher.windowInFront().then(function (r) {
  // r.front: { app, data, incognito, window } of the launched window in front, or null
  // r.last:  the same for the launched window that was in front most recently, or null
});
```

Chrome delivers these messages to the portal page even when it is a background tab. Timers in
background tabs are slowed down, so do the work directly in the event handler rather than after a
`setTimeout`.

## 7. Sign-out

When the user signs out of your portal, have the extension clean up the applications it launched from
it. Two steps:

```js
function signOut() {
  return SessionLauncher.prepareSignOut()               // 1. "Leave site?" off in launched windows
    .catch(function () { /* extension missing: continue */ })
    .then(function () { return signOutOfOtherSystems(); }) // e.g. a sign-on agent, see section 9
    .then(function () { return SessionLauncher.finishSignOut(); }) // 2. close and clean up
    .catch(function () { /* continue */ })
    .then(function () { location.href = '/signed-out'; });
}
```

| Step | Effect | Result |
|---|---|---|
| `signOut.prepare` | Switches off "Leave site?" in every window launched from this portal, so other software closing them is not held up. | `{ windows }` |
| `signOut.finish` | Closes the windows launched from this portal that are still open. Then clears the cookies and stored data of **every** site launched from this portal since its last sign-out, including sites whose windows were closed earlier. | `{ closed, kept, cookiesCleared }` |

`kept` counts windows that stayed open because a page still showed "Leave site?" and the user chose to
stay. Their sites are cleaned up at the next sign-out.

If you have nothing else to sign out of, call the two steps one after the other.

## 8. Deploying to an organisation

Chrome policies let an administrator install the extension for everyone and approve the portal, so users
are never asked.

**Install for all users** (`ExtensionInstallForcelist`, or `ExtensionSettings`):

```
<extension ID>;https://clients2.google.com/service/update2/crx
```

**Approve portals** (policy for the extension, under `3rdparty` → `extensions` → `<extension ID>`):

```json
{
  "approvedPortals": ["https://portal.example.com", "https://portal-test.example.com"],
  "defaultIfOpen": "ask",
  "defaultParallel": ["incognito", "separate"],
  "defaultWindow": "normal"
}
```

On Windows these are set under
`HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\<extension ID>\policy`; with Google Admin
console, under the extension's "Policy for extensions". `launch` requests may still set `ifOpen`,
`parallel` and `window`; the defaults apply when they do not.

**"Allow in Incognito"** must be turned on by each user in `chrome://extensions`, unless your Chrome
management tools provide a way to set it. Without it, `window: 'incognito'` fails with
`incognito-not-allowed`, and the confirmation page explains how to turn it on.

## 9. Using it with a sign-on agent

Sign-on agents fill application logins with one account at a time. With the launch `data` and the
`window.focused` event, your portal can switch the agent to the account of the window in front, so two
windows of the same application can be signed in with different accounts.

1. **Launch with the account in `data`**, after preparing the agent for that account:

   ```js
   SessionLauncher.launch({ url: 'https://crm.example.com/login', app: 'crm', data: { account: 'ID3' } });
   ```

2. **Follow the window in front** (section 6): on each `window.focused` event, switch the agent to
   `event.data` if it is not already on it. Do the switch in the event handler itself.

3. **Keep the agent's session alive**, if it needs it: periodically ask `windows.front` and re-select the
   account of the window in front (`front`, else `last`).

4. **Sign out in this order:** `signOut.prepare`, then sign the agent out, then `signOut.finish`. The agent may
   close the windows it recognises; the extension then closes the rest and cleans up. Calling
   `signOut.finish` last avoids closing windows the agent still expects to find.

**i-Sprint AccessMatrix Universal Sign-On (USO):** i-Sprint's USO integration library for web pages
(`uso-extension-client.js`, version 1.5 or later) does steps 2 and 3 for USOClient:
`UsoExtension.followLaunchedWindows(SessionLauncher)` and `UsoExtension.keepAlive(SessionLauncher)`, with
`data: { uso: [{ appId, slot }] }` on each launch. The portal page must be open with `webui` in its address,
as the USO Chrome extension requires. For separate-browser windows, launch with
`separateBrowser: { waitFor: 'uso' }`, so the window opens the application once the USO Chrome extension is active
in it. Ask i-Sprint for the library and its documentation.

## 10. Security notes

- **Only approved sites.** Requests from other sites, and from your pages without the marker, are
  ignored or rejected with `not-approved`.
- **Cleaning up is limited to what your portal launched.** `signOut.finish` touches only windows and
  sites launched from your portal. `launch` closes and clears only the application being launched, and
  only after the user chooses to, or because you asked with `ifOpen: 'close'`.
- **Events go only to your portal.** `window.focused` and `windows.front` report only windows launched
  from your origin, with the `app` and `data` you gave.
- **No passwords.** Requests carry addresses, your IDs and your `data`, never credentials. Keep secrets
  out of `data`: it is stored in the browser for the life of the window. Provision login details to your
  sign-on system from your server, never through the browser.
- **Nothing leaves the browser.** The extension stores approvals, launched windows and sites to clean up
  in the browser only. It sends nothing to any server.

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| `hello` times out | The extension is installed and enabled; the page has the `<meta name="secure-session-launcher">` marker; the page is HTTPS or `localhost`. |
| `not-approved` | Call `requestApproval` from a button, have the user choose **Allow this site** from the extension's toolbar icon, or approve the site by policy. Check the origin matches exactly, including the port. |
| `incognito-not-allowed` | Turn on "Allow in Incognito" for the extension (and the USO extension) in `chrome://extensions`. |
| The application opens already signed in after "Close & continue" | The application may keep its session on a host the extension does not clear, such as a separate login server. Launch it in incognito, or ask i-Sprint about including the login server. |
| No `window.focused` events | The page is marked `portal` and subscribed; it is the most recent page of your origin that subscribed; the window was launched from this origin. |
| A sign-on agent fills the wrong account | The portal page is subscribed to `window.focused` (and, for USO, open with `webui` in its address); the launch `data` identifies the account; the agent was ready before following windows. |
| The portal window closes at sign-out | Sign the agent out before calling `signOut.finish` (section 9). |

## 12. Reference

### Requests

| `type` | Marker | Fields | Result fields |
|---|---|---|---|
| `hello` | `portal`, `launch` | None | `version`, `approved`, `incognitoAllowed`, `separateBrowserAvailable` |
| `requestApproval` | `portal`, `launch` | None | `approved` |
| `launch` | `portal`, `launch` | `url`, `app`, `data`, `ifOpen`, `window`, `closeRequestingTab` | `outcome` |
| `events.subscribe` | `portal` | `events`: `['window.focused']` | `events` |
| `windows.front` | `portal` | None | `front`, `last` |
| `signOut.prepare` | `portal` | None | `windows` |
| `signOut.finish` | `portal` | None | `closed`, `kept`, `cookiesCleared` |

### Events

| `event` | Fields |
|---|---|
| `window.focused` | `app`, `data`, `incognito`, `window` |

### Error codes

| `code` | Meaning |
|---|---|
| `not-approved` | The site is not approved, or the user declined. |
| `not-allowed-here` | This request needs a page marked `portal`. |
| `incognito-not-allowed` | `window: 'incognito'` but "Allow in Incognito" is off. |
| `invalid-request` | A field is missing or invalid (for example `data` over 4 KB); `message` says which. |
| `internal` | Unexpected error; `message` has the details. |

### Versions

| Version | Changes |
|---|---|
| 1.0 | First public interface. |
| 1.0 (extension 1.0.3) | `hello` adds `separateBrowserAvailable`; "Open parallel session in a separate browser" with the optional helper. No change for existing portals. |
| 1.0 (extension 1.0.4) | Separate-browser windows count as "already open", and "Close active session & continue" closes them. |
| 1.0 (extension 1.0.5) | `launch` takes `parallel` (which choices to offer); "Open parallel session" renamed "Continue without closing". |
| 1.0 (extension 1.0.6) | `launch` takes `separateBrowser.waitFor`. |
