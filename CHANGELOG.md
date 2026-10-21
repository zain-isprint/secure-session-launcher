# Changes

## 1.0.6

- `launch` takes `separateBrowser: { waitFor: 'uso' }`: a separate-browser window first waits until the USO Chrome
  extension is active in it. Without it, the window opens the application at once (Secure Session Helper 0.5.0).

## 1.0.5

- The portal chooses the confirmation page's choices: `launch` takes `parallel` (`shared`, `incognito`,
  `separate`); "Close active session & continue" and "Cancel launch" are always shown. Policy `defaultParallel`.
- "Open parallel session" is now **Continue without closing**, in its own colour: it shares the open window's
  sign-in, so it is for a second window of the same account.

## 1.0.4

- Separate-browser windows count as "already open", and "Close active session & continue" closes them too.

## 1.0.3

- **Open parallel session in a separate browser**: with the optional Windows program Secure Session Helper
  ([helper/](helper/)), the application opens in a separate window of the same browser (Chrome or Edge) with an
  isolated profile. Its focus is reported to the portal as `window.focused`, and sign-out closes it.
  `hello` returns `separateBrowserAvailable`. New permission: `nativeMessaging`.
- The manifest has a `key`, so the extension loaded from this repository has a fixed ID
  (`mbbaaodhkbilnbmpgbolecjdjkpinmjd`), which the helper allows.
- Launched windows are still recognised after the extension restarts (for example when "Allow in Incognito" is
  changed). The incognito choice is disabled, with an explanation, when incognito is not allowed.

## 1.0.2

- Fresh start for every launch: when an application is not open, its site's sign-in data is cleared before it
  opens, so it starts at its login page (for example after the user closed the previous window themselves).
  Nothing is cleared while any tab on that site is open.

## 1.0.1

- Approve a portal from the extension's toolbar icon ("Allow this site"), on pages that carry the
  `secure-session-launcher` marker. Approved sites can also be removed there.

## 1.0.0

- First version of the public interface (developer guide, interface 1.0): approval of portal sites (by the user
  or by Chrome policy), `launch` with already-open handling, close and continue without "Leave site?",
  parallel sessions in normal or incognito windows, sign-in data clean-up, sign-out (`signOut.prepare`,
  `signOut.finish`), `window.focused` events and `windows.front`.
