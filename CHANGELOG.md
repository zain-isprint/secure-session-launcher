# Changes

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
