# Privacy

Secure Session Launcher does not collect, send, sell or share any data. It has no server and makes no
network requests of its own.

## What it stores, in your browser only

| Data | Why | Kept until |
|---|---|---|
| The portals you (or your organisation) approved | To act only for those sites | You remove an approval (toolbar icon or options page), or uninstall the extension |
| Which tabs a portal launched, with the portal's application ID and data for each | To recognise an application that is already open, and to report which window is in front to that portal | The tab is closed, or the browser is closed |
| The sites a portal launched since its last sign-out | To clear their sign-in data when you sign out of that portal | That portal's next sign-out |

The data a portal attaches to a launch is chosen by that portal; the extension stores it unchanged and returns
it only to the same portal. Portals should not put secrets in it.

## What it changes

When you choose to close an application, sign out of a portal, or launch an application that is not open, the
extension clears that application's cookies (for its host and parent domains) and its stored data
(localStorage, IndexedDB, caches, service workers). Cookies that the portal's own site also uses are never
cleared. It never reads the content of the pages you visit; the only script it runs in an application page
switches off that page's "Leave site?" prompt just before closing it.
