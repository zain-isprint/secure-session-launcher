# Example portal

[portal.html](portal.html) is a small portal that uses every part of the extension's interface. It is plain
HTML and JavaScript, using [`client/secure-session-launcher.js`](../client/secure-session-launcher.js).

## Run it

1. Install the extension: `chrome://extensions` → **Developer mode** → **Load unpacked** → the `extension`
   folder.
2. From the repository folder, start a local web server, for example:

   ```
   python -m http.server 8000
   ```

   (or `npx http-server -p 8000`; any free port works). The page must come from `localhost` or HTTPS; the extension does not
   answer `file://` pages.
3. Open `http://localhost:8000/examples/portal.html`.

## What to try

| Step | Button | What happens |
|---|---|---|
| 1 | **Check extension** | `hello`: version, whether this portal is approved, whether incognito is allowed. |
| 1 | **Approve this portal** | `requestApproval`: the extension asks you to allow `http://localhost:8000`. Until you do, other requests fail with `not-approved`. You can also use the extension's toolbar icon → **Allow this site**. |
| 2 | **Example (as alice)** | `launch`: example.com opens in its own window, with `{ account: 'alice' }` as its data. |
| 2 | **Example (as bob)** while alice's window is open | The application is already open: the extension shows its confirmation page (close and continue, parallel session, parallel session in incognito, cancel). With "When already open: close and continue", it closes alice's window, clears example.com's sign-in data and opens a new one, without asking. |
| 2 | Window: **incognito** | The application opens in an incognito window (turn on "Allow in Incognito" for the extension first). |
| 3 | **Follow the window in front** | `events.subscribe`. Then switch between the application windows: each switch logs a `window.focused` event with that window's app ID and data. A sign-on agent would use this to switch accounts. |
| 3 | **Which window is in front?** | `windows.front`: the launched window in front now, and the one in front most recently. |
| 4 | **Sign out** | `signOut.prepare` then `signOut.finish`: the application windows close (without "Leave site?"), and the sign-in data of every site launched from this portal since the last sign-out is cleared. |
