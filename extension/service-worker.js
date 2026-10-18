/*
 * Secure Session Launcher - service worker.
 *
 * Portal pages (marked with <meta name="secure-session-launcher">) send requests through content.js.
 * Every request except "hello" needs the page's origin to be approved: by the user, from the portal's own
 * button (requestApproval) or from the toolbar popup (popup.html), or by policy (managed storage
 * "approvedPortals"). The extension never asks on its own. See DEVELOPER-GUIDE.md for the interface.
 *
 * 1. Launch: opens the application in a new normal or incognito window and remembers, per tab, which
 *    portal launched it with which app ID and data. If the application is already open (a tab launched
 *    from the same portal for the same app that is still on the target's site, or any tab at exactly the
 *    target URL), it asks on confirm.html, or closes it and continues ("ifOpen: close"). When it is not
 *    open, its site's cookies and stored data are cleared first (unless another tab on that host is open),
 *    so it starts at its login page (freshStart).
 *
 * 2. "Close active session & continue": the old tabs' "Leave site?" prompts are switched off and the
 *    tabs closed. A page that still prompts can hold this up; while it does, the tab is marked "closing".
 *    If the user stays (Cancel on the prompt), the launch is abandoned. Once the old tabs are gone, the
 *    cookies of the application's host and its parent domains are cleared (never cookies the portal's
 *    host also receives), and the origin's stored data, then the new window opens.
 *
 * 3. "Open parallel session": keeps the old tabs and opens another window, normal (shared cookies) or
 *    incognito (own cookies and storage).
 *
 * 4. Window events: the portal page can subscribe to "window.focused". When the user brings a tab launched
 *    from that portal to the front, the page gets the tab's app ID and data. The extension does not
 *    interpret the data (i-Sprint's USO library uses it to switch USOClient's profile).
 *
 * 5. Sign-out: "signOut.prepare" switches off "Leave site?" in the portal's launched tabs; "signOut.finish"
 *    closes those still open and clears the cookies and stored data of every site launched from the portal
 *    since its last sign-out.
 */
const LOG = '[Session Launcher]';
const PENDING_PREFIX = 'pending:';            // session: request id -> launch waiting for the user's choice
const CLOSE_PREFIX = 'closing:';              // session: request id -> "Close & continue" waiting for old tabs
const TAB_PREFIX = 'tab:';                    // session: tab id -> { portal, app, data, origin, hostname, incognito, closing? }
const SUBSCRIBERS_KEY = 'subscribers';        // session: { portal origin: tab id } receiving window events
const LAST_FOCUSED_KEY = 'lastFocused';       // session: { portal origin: tab id } launched tab most recently in front
const APPROVAL_PREFIX = 'approval:';          // session: approval id -> { origin, tabId }
const SITES_KEY = 'launchedSites';            // local: { portal origin: [application origin] } since the portal's last sign-out
const APPROVED_KEY = 'approvedPortals';       // local: [origin] approved by the user
const FOCUS_SETTLE_MS = 300;
const STAYED_CHECK_MS = 300;                  // see watchLeavePrompt()
const STAYED_CONFIRM_MS = 700;                // see handleStayed()
const SUPPRESS_WAIT_MS = 500;                 // see suppressLeavePrompt()
const SIGN_OUT_CLOSE_WAIT_MS = 5000;
const APPROVAL_WAIT_MS = 120000;
const MAX_DATA_BYTES = 4096;
const INCOGNITO_NOT_ALLOWED = 'Incognito is not allowed for Secure Session Launcher. In chrome://extensions, open Details for '
  + 'Secure Session Launcher (and for any sign-on extension the application needs) and turn on "Allow in Incognito".';

console.log(LOG, 'Service worker active.');

class LauncherError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ---------------------------------------------------------------------------------------------
 * Messages
 * ------------------------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || sender.id !== chrome.runtime.id) return false;
  const reply = (promise) => { promise.then(sendResponse).catch(error => sendResponse({ error: error.message })); return true; };

  if (message.kind === 'page-request') {
    handlePageRequest(message, sender).then(result => sendResponse(Object.assign({ ok: true }, result))).catch(error => {
      const code = error instanceof LauncherError ? error.code : 'internal';
      if (code === 'internal') console.warn(LOG, 'Request failed:', error);
      sendResponse({ ok: false, error: { code, message: error.message } });
    });
    return true;
  }

  // Scripts injected into application tabs that are being closed (watchLeavePrompt).
  if (message.kind === 'leave-prompt') { console.log(LOG, `Tab ${sender.tab && sender.tab.id} is showing "Leave site?".`); return false; }
  if (message.kind === 'leave-stayed') { handleStayed(message.requestId, sender.tab).catch(() => {}); return false; }

  // The extension's own pages only.
  if (!isExtensionPage(sender)) return false;
  switch (message.kind) {
    case 'get-pending': return reply(getPending(message.requestId));
    case 'cancel-launch': return reply(cancelLaunch(message.requestId));
    case 'confirm-launch': return reply(confirmLaunch(message.requestId, sender));
    case 'launch-parallel': return reply(handleParallelLaunch(message.requestId, message.incognito === true));
    case 'approval-get': return reply(getApproval(message.id));
    case 'approval-answer': return reply(answerApproval(message.id, message.allow === true));
    case 'options-get': return reply(getOptions());
    case 'options-remove': return reply(removeApproval(message.origin));
    case 'popup-approve': return reply(approveFromPopup(message.origin));
    default: return false;
  }
});

function isExtensionPage(sender) {
  return !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
}

async function handlePageRequest(message, sender) {
  if (!sender.tab || sender.tab.id == null || !sender.url) throw new LauncherError('invalid-request', 'Requests must come from a page in a tab.');
  const origin = new URL(sender.url).origin;
  const request = message.request || {};
  const role = message.role;
  const portalOnly = ['events.subscribe', 'windows.front', 'signOut.prepare', 'signOut.finish'];

  if (request.type === 'hello') {
    return { version: chrome.runtime.getManifest().version, approved: await isApproved(origin),
      incognitoAllowed: await chrome.extension.isAllowedIncognitoAccess() };
  }
  if (portalOnly.includes(request.type) && role !== 'portal') {
    throw new LauncherError('not-allowed-here', `"${request.type}" needs a page marked <meta name="secure-session-launcher" content="portal">.`);
  }
  if (request.type === 'requestApproval') return requestApproval(origin, sender.tab);
  if (!(await isApproved(origin))) {
    throw new LauncherError('not-approved', `${origin} is not approved in Secure Session Launcher. Approve it when asked, or ask your administrator.`);
  }
  switch (request.type) {
    case 'launch': return handleLaunch(request, sender.tab, origin);
    case 'events.subscribe': return subscribe(request, sender.tab, origin);
    case 'windows.front': return windowsFront(origin);
    case 'signOut.prepare': return prepareSignOut(origin);
    case 'signOut.finish': return finishSignOut(origin);
    default: throw new LauncherError('invalid-request', `Unknown request "${request.type}".`);
  }
}

/* ---------------------------------------------------------------------------------------------
 * Approval of portal sites
 * ------------------------------------------------------------------------------------------- */

async function managedSettings() {
  try { return await chrome.storage.managed.get(null); } catch { return {}; }
}

async function approvedOrigins() {
  const local = (await chrome.storage.local.get(APPROVED_KEY))[APPROVED_KEY] || [];
  const managed = (await managedSettings()).approvedPortals || [];
  return { local, managed: managed.map(normalizeOrigin).filter(Boolean) };
}

function normalizeOrigin(value) {
  try { return new URL(String(value)).origin; } catch { return ''; }
}

async function isApproved(origin) {
  const { local, managed } = await approvedOrigins();
  return local.includes(origin) || managed.includes(origin);
}

const approvalWaiters = new Map(); // approval id -> resolve(boolean); lost if the worker restarts (the page then times out)

async function requestApproval(origin, tab) {
  if (await isApproved(origin)) return { approved: true };
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [APPROVAL_PREFIX + id]: { origin, tabId: tab.id } });
  const answer = new Promise(resolve => {
    approvalWaiters.set(id, resolve);
    setTimeout(() => resolve(false), APPROVAL_WAIT_MS);
  });
  const approvalTab = await chrome.tabs.create({ url: chrome.runtime.getURL('approve.html') + '?id=' + encodeURIComponent(id), windowId: tab.windowId });
  await chrome.storage.session.set({ [APPROVAL_PREFIX + id]: { origin, tabId: tab.id, approvalTabId: approvalTab.id } });
  const allowed = await answer;
  approvalWaiters.delete(id);
  await chrome.storage.session.remove(APPROVAL_PREFIX + id);
  chrome.tabs.remove(approvalTab.id).catch(() => {});
  chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  if (!allowed) throw new LauncherError('not-approved', `${origin} was not approved.`);
  return { approved: true };
}

async function getApproval(id) {
  const pending = (await chrome.storage.session.get(APPROVAL_PREFIX + id))[APPROVAL_PREFIX + id];
  return pending ? { origin: pending.origin } : null;
}

async function answerApproval(id, allow) {
  const pending = (await chrome.storage.session.get(APPROVAL_PREFIX + id))[APPROVAL_PREFIX + id];
  if (!pending) throw new Error('This request has expired. Return to the portal and try again.');
  if (allow) {
    const local = (await chrome.storage.local.get(APPROVED_KEY))[APPROVED_KEY] || [];
    if (!local.includes(pending.origin)) await chrome.storage.local.set({ [APPROVED_KEY]: local.concat(pending.origin) });
    console.log(LOG, `Approved ${pending.origin}.`);
  }
  const resolve = approvalWaiters.get(id);
  if (resolve) resolve(allow);
  return { approved: allow };
}

async function getOptions() {
  const { local, managed } = await approvedOrigins();
  const settings = await managedSettings();
  return {
    version: chrome.runtime.getManifest().version,
    approved: local,
    managed,
    defaultIfOpen: settings.defaultIfOpen || 'ask',
    defaultWindow: settings.defaultWindow || 'normal',
    incognitoAllowed: await chrome.extension.isAllowedIncognitoAccess()
  };
}

/** The toolbar popup's "Allow this site" (popup.js checks that the page carries the extension's marker). */
async function approveFromPopup(value) {
  const origin = normalizeOrigin(value);
  if (!/^https?:\/\//.test(origin)) throw new Error('Only web sites can be approved.');
  const local = (await chrome.storage.local.get(APPROVED_KEY))[APPROVED_KEY] || [];
  if (!local.includes(origin)) await chrome.storage.local.set({ [APPROVED_KEY]: local.concat(origin) });
  console.log(LOG, `Approved ${origin} from the toolbar.`);
  return getOptions();
}

async function removeApproval(origin) {
  const local = (await chrome.storage.local.get(APPROVED_KEY))[APPROVED_KEY] || [];
  await chrome.storage.local.set({ [APPROVED_KEY]: local.filter(o => o !== origin) });
  return getOptions();
}

/* ---------------------------------------------------------------------------------------------
 * Launch
 * ------------------------------------------------------------------------------------------- */

async function handleLaunch(request, requesterTab, portal) {
  let target;
  try { target = new URL(String(request.url)); } catch { throw new LauncherError('invalid-request', '"url" is missing or not a valid address.'); }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new LauncherError('invalid-request', '"url" must start with http:// or https://.');
  const app = request.app == null ? '' : String(request.app);
  if (app.length > 200) throw new LauncherError('invalid-request', '"app" must be 200 characters or fewer.');
  const data = request.data === undefined ? null : request.data;
  if (new TextEncoder().encode(JSON.stringify(data)).length > MAX_DATA_BYTES) {
    throw new LauncherError('invalid-request', `"data" must be ${MAX_DATA_BYTES} bytes or fewer as JSON.`);
  }
  const settings = await managedSettings();
  const ifOpen = request.ifOpen || settings.defaultIfOpen || 'ask';
  const windowMode = request.window || settings.defaultWindow || 'normal';
  if (!['ask', 'close'].includes(ifOpen)) throw new LauncherError('invalid-request', '"ifOpen" must be "ask" or "close".');
  if (!['normal', 'incognito'].includes(windowMode)) throw new LauncherError('invalid-request', '"window" must be "normal" or "incognito".');
  const incognito = windowMode === 'incognito';
  if (incognito && !(await chrome.extension.isAllowedIncognitoAccess())) throw new LauncherError('incognito-not-allowed', INCOGNITO_NOT_ALLOWED);
  const closeRequestingTab = request.closeRequestingTab === true;
  const launch = { portal, app, data };

  const targetMatchUrl = matchUrl(target.href);
  const matches = await findOpenTabs(target, targetMatchUrl, portal, app, requesterTab.id);

  if (matches.length === 0) {
    await freshStart(target, portal);
    await openTarget(target.href, launch, incognito);
    if (closeRequestingTab) chrome.tabs.remove(requesterTab.id).catch(() => {});
    return { outcome: 'opened' };
  }

  const requestId = crypto.randomUUID();
  const pending = {
    requestId,
    targetUrl: target.href,
    hostname: target.hostname.toLowerCase(),
    matchUrl: targetMatchUrl,
    matchingTabIds: matches.map(tab => tab.id),
    matchingUrls: matches.map(tab => tab.url),
    matchingIncognito: matches.some(tab => tab.incognito),
    stagingTabId: closeRequestingTab ? requesterTab.id : null,
    launch,
    incognito,
    portalHostname: new URL(portal).hostname.toLowerCase()
  };
  await chrome.storage.session.set({ [PENDING_PREFIX + requestId]: pending });
  if (ifOpen === 'close') {
    console.log(LOG, `${targetMatchUrl} is already open; closing it and continuing without asking.`);
    const result = await confirmLaunch(requestId, {});
    return { outcome: result.waiting ? 'closing' : 'opened' };
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('confirm.html') + '?id=' + encodeURIComponent(requestId), windowId: requesterTab.windowId });
  return { outcome: 'confirming' };
}

/**
 * Before opening an application that is not open: clear its site's cookies and stored data, so it starts
 * at its login page rather than signed in with whatever account was used last (e.g. after the user closed
 * the previous window with X, or Chrome was closed). Skipped while any tab on that host is open, even one
 * the extension did not launch, so it is never signed out; and for the portal's own host. Cookies the
 * portal's host also receives are kept, as always.
 */
async function freshStart(target, portal) {
  const hostname = target.hostname.toLowerCase();
  const portalHostname = new URL(portal).hostname.toLowerCase();
  if (hostname === portalHostname) return;
  const open = (await chrome.tabs.query({})).some(tab => {
    try { return new URL(tab.url).hostname.toLowerCase() === hostname; } catch { return false; }
  });
  if (open) {
    console.log(LOG, `${hostname} is open in another tab; launching without clearing its sign-in data.`);
    return;
  }
  await clearSiteCookies(hostname, portalHostname).catch(error => console.warn(LOG, 'Cookie clear skipped:', error));
  await clearSiteStorage(target.origin).catch(error => console.warn(LOG, 'Storage clear skipped:', error));
}

/** Opens the target in a new window and remembers which portal launched it, with its app ID and data. */
async function openTarget(url, launch, incognito = false) {
  const win = await chrome.windows.create({ url, focused: true, type: 'normal', incognito });
  const tab = win && win.tabs && win.tabs[0];
  if (tab && tab.id != null) {
    const target = new URL(url);
    await chrome.storage.session.set({ [TAB_PREFIX + tab.id]: {
      portal: launch.portal, app: launch.app, data: launch.data,
      origin: target.origin, hostname: target.hostname.toLowerCase(), incognito
    } });
    await noteLaunchedSite(launch.portal, target.origin);
    console.log(LOG, `Tab ${tab.id} launched${incognito ? ' (incognito)' : ''} from ${launch.portal}${launch.app ? ' for ' + launch.app : ''}.`);
  }
  return win;
}

/**
 * Tabs already open for this application: a tab launched from the same portal for the same app that is
 * still on the target's site (scheme, host and port), whatever page it has moved to (e.g. github.com/login
 * becomes github.com/ after sign-in); or any tab at exactly the target URL (ignoring ?query and #fragment).
 */
async function findOpenTabs(target, targetMatchUrl, portal, app, excludeTabId) {
  const stored = await chrome.storage.session.get(null);
  const tabs = await chrome.tabs.query({});
  return tabs.filter(tab => {
    if (!tab.url || tab.id === excludeTabId) return false;
    let url;
    try { url = new URL(tab.url); } catch { return false; }
    if (matchUrl(url.href) === targetMatchUrl) return true;
    const launched = stored[TAB_PREFIX + tab.id];
    return !!app && !!launched && launched.portal === portal && launched.app === app && url.origin === target.origin;
  });
}

function matchUrl(value) {
  try {
    const url = new URL(value); url.hash = ''; url.search = '';
    return url.href.replace(/\/$/, '');
  } catch { return value; }
}

async function getPending(requestId) {
  const pending = (await chrome.storage.session.get(PENDING_PREFIX + requestId))[PENDING_PREFIX + requestId];
  if (!pending) return null;
  return {
    requestId: pending.requestId,
    portal: pending.launch.portal,
    targetUrl: pending.targetUrl,
    hostname: pending.hostname,
    matchUrl: pending.matchUrl,
    matchingUrls: pending.matchingUrls,
    matchingIncognito: pending.matchingIncognito === true,
    incognito: pending.incognito === true,
    incognitoAllowed: await chrome.extension.isAllowedIncognitoAccess(),
    sameAsPortalHost: pending.hostname === pending.portalHostname
  };
}

async function takePending(requestId) {
  const key = PENDING_PREFIX + requestId;
  const pending = (await chrome.storage.session.get(key))[key];
  if (!pending) throw new Error('This launch request has expired. Return to the portal and try again.');
  await chrome.storage.session.remove(key);
  return pending;
}

async function cancelLaunch(requestId) {
  if (await closeQueue(() => abortClose(requestId, 'cancelled on the confirmation page'))) return { cancelled: true };
  const key = PENDING_PREFIX + requestId;
  const pending = (await chrome.storage.session.get(key))[key];
  if (pending) {
    await chrome.storage.session.remove(key);
    if (pending.stagingTabId != null) await chrome.tabs.remove(pending.stagingTabId).catch(() => {});
  }
  return { cancelled: true };
}

/**
 * "Close active session & continue": close the matching tabs, then wait. The new window is opened by
 * finishClose() once all of them are gone (tabs.onRemoved), or the launch is abandoned by abortClose()
 * when the user keeps one of them open with the "Leave site?" prompt.
 */
async function confirmLaunch(requestId, sender) {
  const pending = await takePending(requestId);
  const openIds = new Set((await chrome.tabs.query({})).map(tab => tab.id));
  const waitingTabIds = (pending.matchingTabIds || []).filter(id => openIds.has(id));

  const state = {
    requestId,
    targetUrl: pending.targetUrl,
    launch: pending.launch,
    incognito: pending.incognito === true,
    hostname: pending.hostname,
    portalHostname: pending.portalHostname,
    stagingTabId: pending.stagingTabId,
    confirmTabId: sender.tab ? sender.tab.id : null,
    waitingTabIds
  };
  await chrome.storage.session.set({ [CLOSE_PREFIX + requestId]: state });
  if (pending.stagingTabId != null) chrome.tabs.remove(pending.stagingTabId).catch(() => {});

  if (!waitingTabIds.length) {
    await closeQueue(() => finishClose(requestId, false));
    return { opened: true };
  }

  await setClosing(waitingTabIds, requestId);
  await Promise.all(waitingTabIds.map(tabId => suppressLeavePrompt(tabId)));
  await Promise.all(waitingTabIds.map(tabId => chrome.scripting.executeScript({
    target: { tabId }, func: watchLeavePrompt, args: [requestId, STAYED_CHECK_MS]
  }).catch(() => {}))); // pages the extension cannot script still close; only "Cancel" goes unnoticed there
  // Not awaited: with a "Leave site?" prompt, Chrome finishes only after the user answers.
  waitingTabIds.forEach(tabId => chrome.tabs.remove(tabId).catch(() => {}));
  console.log(LOG, `Closing tab(s) ${waitingTabIds.join(', ')} before opening ${pending.targetUrl}.`);
  return { waiting: true };
}

/**
 * Switches off the page's "Leave site?" prompt (beforeunload) in every frame of the tab, so closing it
 * needs no click. Used only for tabs the user chose to close, or the portal signs out of. A page asks for
 * the prompt by calling preventDefault() on the event, setting its returnValue, or returning a value from
 * onbeforeunload; all three are made to do nothing. (Stopping the page's own listener does not work:
 * Chrome runs it first.) A tab already showing the prompt is frozen, so the script would wait for the
 * answer; it is never allowed to hold up the close.
 */
function suppressLeavePrompt(tabId) {
  const timeout = new Promise(resolve => setTimeout(resolve, SUPPRESS_WAIT_MS));
  const inject = chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: () => {
      const preventDefault = Event.prototype.preventDefault;
      Event.prototype.preventDefault = function () { if (this.type !== 'beforeunload') return preventDefault.call(this); };
      Object.defineProperty(BeforeUnloadEvent.prototype, 'returnValue', { configurable: true, get() { return ''; }, set() {} });
      window.onbeforeunload = null;
      Object.defineProperty(window, 'onbeforeunload', { configurable: true, get() { return null; }, set() {} });
    }
  }).catch(error => console.warn(LOG, `Could not switch off "Leave site?" in tab ${tabId}:`, error.message));
  return Promise.race([timeout, inject]);
}

/**
 * Runs in the old application tab (the extension's isolated world) just before it is closed. If the page
 * still shows "Leave site?", Chrome freezes it until the user answers, so a short timer set here only runs
 * when the user chose to stay (with Leave, the page is gone first).
 */
function watchLeavePrompt(requestId, stayedCheckMs) {
  const watch = window.__sslLeaveWatch || (window.__sslLeaveWatch = { requestId: null, left: false });
  watch.requestId = requestId;
  if (watch.installed) return;
  watch.installed = true;
  window.addEventListener('pagehide', () => { watch.left = true; });
  window.addEventListener('beforeunload', (event) => {
    const id = watch.requestId;
    if (!id) return;
    if (event.defaultPrevented || event.returnValue) chrome.runtime.sendMessage({ kind: 'leave-prompt', requestId: id }).catch(() => {});
    setTimeout(() => {
      if (watch.left || watch.requestId !== id) return;
      watch.requestId = null;
      chrome.runtime.sendMessage({ kind: 'leave-stayed', requestId: id }).catch(() => {});
    }, stayedCheckMs);
  });
}

/** The page is still alive after its "Leave site?" prompt; counts only if the tab still exists a moment later. */
async function handleStayed(requestId, tab) {
  await new Promise(resolve => setTimeout(resolve, STAYED_CONFIRM_MS));
  const stillOpen = tab && tab.id != null && await chrome.tabs.get(tab.id).then(() => true, () => false);
  if (!stillOpen) return;
  await closeQueue(async () => {
    const state = await getCloseState(requestId);
    if (state && state.waitingTabIds.includes(tab.id)) await abortClose(requestId, 'the user chose to stay on ' + tab.url);
  });
}

let closeChain = Promise.resolve();
/** Close-and-continue state changes one at a time (tab removals and "stayed" reports can race). */
function closeQueue(task) {
  const run = closeChain.then(task);
  closeChain = run.catch(error => console.warn(LOG, 'Close & continue:', error.message));
  return run;
}

async function getCloseState(requestId) {
  return (await chrome.storage.session.get(CLOSE_PREFIX + requestId))[CLOSE_PREFIX + requestId];
}

async function allCloseStates() {
  const everything = await chrome.storage.session.get(null);
  return Object.keys(everything).filter(key => key.startsWith(CLOSE_PREFIX)).map(key => everything[key]);
}

/** Every old tab has closed: clear the site's cookies and stored data, open the new window, close the confirmation tab. */
async function finishClose(requestId, closeConfirmTab = true) {
  const state = await getCloseState(requestId);
  if (!state) return;
  await chrome.storage.session.remove(CLOSE_PREFIX + requestId);
  // Only now: had the user kept the old tab, clearing earlier would have broken its session.
  if (state.hostname !== state.portalHostname) {
    await clearSiteCookies(state.hostname, state.portalHostname).catch(error => console.warn(LOG, 'Cookie clear skipped:', error));
    await clearSiteStorage(new URL(state.targetUrl).origin).catch(error => console.warn(LOG, 'Storage clear skipped:', error));
  }
  await openTarget(state.targetUrl, state.launch, state.incognito === true);
  if (closeConfirmTab && state.confirmTabId != null) chrome.tabs.remove(state.confirmTabId).catch(() => {});
}

/** The user kept an old tab (Cancel on "Leave site?") or cancelled the wait: abandon the launch. */
async function abortClose(requestId, reason) {
  const state = await getCloseState(requestId);
  if (!state) return false;
  await chrome.storage.session.remove(CLOSE_PREFIX + requestId);
  console.log(LOG, `Launch of ${state.targetUrl} abandoned: ${reason}.`);
  await setClosing(state.waitingTabIds, null);
  [state.confirmTabId, state.stagingTabId].filter(id => id != null).forEach(id => chrome.tabs.remove(id).catch(() => {}));
  // Focus may have moved to the kept tab while it was "closing" and was ignored; report it now.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (tab) scheduleFocus(tab.id);
  return true;
}

/** Marks (requestId) or unmarks (null) launched tabs as closing; closing tabs produce no window events. */
async function setClosing(tabIds, requestId) {
  for (const tabId of tabIds) {
    const key = TAB_PREFIX + tabId;
    const launched = (await chrome.storage.session.get(key))[key];
    if (!launched) continue;
    if (requestId) launched.closing = requestId; else delete launched.closing;
    await chrome.storage.session.set({ [key]: launched });
  }
}

/** "Open parallel session": keep the existing tabs and open another window, normal or incognito. */
async function handleParallelLaunch(requestId, incognito) {
  if (incognito && !(await chrome.extension.isAllowedIncognitoAccess())) throw new Error(INCOGNITO_NOT_ALLOWED);
  const pending = await takePending(requestId);
  if (pending.stagingTabId != null) await chrome.tabs.remove(pending.stagingTabId).catch(() => {});
  await openTarget(pending.targetUrl, pending.launch, incognito);
  return { opened: true };
}

/* ---------------------------------------------------------------------------------------------
 * Clearing an application site's cookies and stored data
 * ------------------------------------------------------------------------------------------- */

/**
 * Removes the cookies the application's host receives: those of the host and of its parent domains (e.g.
 * .example.com for login.example.com), in every cookie store (normal and incognito). Cookies the portal's
 * host also receives are kept, so the user stays signed in to the portal. Subdomain cookies are not touched.
 */
async function clearSiteCookies(hostname, protectHostname) {
  hostname = String(hostname || '').toLowerCase();
  if (!hostname) return 0;
  const appliesTo = (cookie, host) => {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    return host === domain || (!cookie.hostOnly && host.endsWith('.' + domain));
  };
  const protect = String(protectHostname || '').toLowerCase();
  let removed = 0;
  for (const store of await chrome.cookies.getAllCookieStores()) {
    const cookies = await chrome.cookies.getAll({ storeId: store.id });
    const targets = cookies.filter(cookie => appliesTo(cookie, hostname) && !(protect && appliesTo(cookie, protect)));
    await Promise.all(targets.map(cookie => {
      const details = { url: (cookie.secure ? 'https://' : 'http://') + cookie.domain.replace(/^\./, '') + (cookie.path || '/'), name: cookie.name, storeId: cookie.storeId };
      if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
      return chrome.cookies.remove(details).catch(() => null);
    }));
    removed += targets.length;
  }
  console.log(LOG, `Cleared ${removed} cookie(s) for ${hostname}${protect ? ' (kept those shared with ' + protect + ')' : ''}.`);
  return removed;
}

/**
 * Removes the application origin's localStorage, IndexedDB, Cache Storage, service workers and file
 * systems. Incognito data goes when the last incognito window closes.
 */
async function clearSiteStorage(origin) {
  if (!origin) return;
  await chrome.browsingData.remove({ origins: [origin] }, { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true });
  console.log(LOG, `Cleared stored data for ${origin}.`);
}

async function noteLaunchedSite(portal, origin) {
  if (!portal || !origin) return;
  const all = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY] || {};
  const list = all[portal] || [];
  if (!list.includes(origin)) { all[portal] = list.concat(origin); await chrome.storage.local.set({ [SITES_KEY]: all }); }
}

async function setLaunchedSites(portal, origins) {
  const all = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY] || {};
  if (origins.length) all[portal] = origins; else delete all[portal];
  await chrome.storage.local.set({ [SITES_KEY]: all });
}

/* ---------------------------------------------------------------------------------------------
 * Sign-out
 * ------------------------------------------------------------------------------------------- */

async function launchedTabsOf(portal) {
  const stored = await chrome.storage.session.get(null);
  return (await chrome.tabs.query({})).map(tab => ({ tab, info: stored[TAB_PREFIX + tab.id] }))
    .filter(x => x.info && x.info.portal === portal);
}

/** Start of sign-out: switch off "Leave site?" in the portal's launched tabs, so other software closing them is not held up. */
async function prepareSignOut(portal) {
  const ids = (await launchedTabsOf(portal)).map(x => x.tab.id);
  await Promise.all(ids.map(id => suppressLeavePrompt(id)));
  if (ids.length) console.log(LOG, `${portal} is signing out: switched off "Leave site?" in tab(s) ${ids.join(', ')}.`);
  return { windows: ids.length };
}

/**
 * End of sign-out: close the portal's launched tabs that are still open, then clear the cookies and stored
 * data of every site launched from the portal since its last sign-out, including sites whose windows were
 * closed earlier. A tab still open after the wait (the user chose to stay on "Leave site?") is left, and so
 * is its site's data, until the next sign-out.
 */
async function finishSignOut(portal) {
  const launched = await launchedTabsOf(portal);
  const sites = await chrome.storage.local.get(SITES_KEY).then(r => (r[SITES_KEY] || {})[portal] || []).catch(() => []);
  if (!launched.length && !sites.length) return { closed: 0, kept: 0, cookiesCleared: 0 };

  const originOf = x => x.info.origin || (() => { try { return new URL(x.tab.url).origin; } catch { return ''; } })();
  const ids = launched.map(x => x.tab.id);
  await setClosing(ids, 'sign-out');
  await Promise.all(ids.map(id => suppressLeavePrompt(id)));
  if (ids.length) console.log(LOG, `${portal} signed out: closing tab(s) ${ids.join(', ')}.`);
  ids.forEach(id => chrome.tabs.remove(id).catch(() => {}));

  const deadline = Date.now() + SIGN_OUT_CLOSE_WAIT_MS;
  let open = ids;
  while (open.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const now = new Set((await chrome.tabs.query({})).map(tab => tab.id));
    open = ids.filter(id => now.has(id));
  }
  if (open.length) await setClosing(open, null);

  const hostOf = origin => { try { return new URL(origin).hostname.toLowerCase(); } catch { return ''; } };
  const keptOrigins = new Set(launched.filter(x => open.includes(x.tab.id)).map(originOf));
  const keptHosts = new Set([...keptOrigins].map(hostOf));
  const portalHostname = hostOf(portal);
  const origins = new Set([...sites, ...launched.map(originOf)].filter(o => /^https?:\/\//.test(o)));
  let cookiesCleared = 0;
  for (const host of new Set([...origins].map(hostOf))) { // cookies are per host, whatever the port
    if (!host || keptHosts.has(host) || host === portalHostname) continue;
    cookiesCleared += await clearSiteCookies(host, portalHostname).catch(() => 0);
  }
  for (const origin of origins) {
    if (keptOrigins.has(origin) || origin === portal) continue;
    await clearSiteStorage(origin).catch(error => console.warn(LOG, 'Storage clear skipped:', error));
  }
  await setLaunchedSites(portal, [...keptOrigins].filter(Boolean)); // still open: cleared at the next sign-out
  return { closed: ids.length - open.length, kept: open.length, cookiesCleared };
}

/* ---------------------------------------------------------------------------------------------
 * Window events
 * ------------------------------------------------------------------------------------------- */

async function subscribe(request, tab, portal) {
  const events = Array.isArray(request.events) ? request.events : [];
  if (!events.includes('window.focused')) throw new LauncherError('invalid-request', '"events" must include "window.focused".');
  const subscribers = (await chrome.storage.session.get(SUBSCRIBERS_KEY))[SUBSCRIBERS_KEY] || {};
  subscribers[portal] = tab.id; // the most recent subscriber of an origin takes over
  await chrome.storage.session.set({ [SUBSCRIBERS_KEY]: subscribers });
  // A discarded (memory-saver) tab cannot receive events; keep the subscribing page loaded.
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  console.log(LOG, `Tab ${tab.id} (${portal}) receives window events.`);
  return { events: ['window.focused'] };
}

function describeWindow(tabId, info) {
  return { app: info.app || null, data: info.data === undefined ? null : info.data, incognito: info.incognito === true, window: 'w' + tabId };
}

async function windowsFront(portal) {
  const stored = await chrome.storage.session.get(null);
  let front = null, last = null;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const frontInfo = tab && stored[TAB_PREFIX + tab.id];
  if (frontInfo && frontInfo.portal === portal && !frontInfo.closing) front = describeWindow(tab.id, frontInfo);
  const lastId = (stored[LAST_FOCUSED_KEY] || {})[portal];
  const lastInfo = lastId != null && stored[TAB_PREFIX + lastId];
  if (lastInfo && !lastInfo.closing) last = describeWindow(lastId, lastInfo);
  return { front, last };
}

let focusTimer = null;
let focusedTabId = null;

chrome.tabs.onActivated.addListener(({ tabId }) => scheduleFocus(tabId));

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // Chrome lost focus (e.g. to a desktop application)
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab) scheduleFocus(tab.id);
});

function scheduleFocus(tabId) {
  focusedTabId = tabId;
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => emitFocus(focusedTabId).catch(error => console.warn(LOG, 'Window event failed:', error.message)), FOCUS_SETTLE_MS);
}

async function emitFocus(tabId) {
  const stored = await chrome.storage.session.get(null);
  const info = stored[TAB_PREFIX + tabId];
  if (!info || info.closing) return; // not launched by a portal, or being closed
  const lastFocused = stored[LAST_FOCUSED_KEY] || {};
  lastFocused[info.portal] = tabId;
  await chrome.storage.session.set({ [LAST_FOCUSED_KEY]: lastFocused });
  const subscriber = (stored[SUBSCRIBERS_KEY] || {})[info.portal];
  if (subscriber == null) return;
  const event = Object.assign({ kind: 'event', event: 'window.focused' }, describeWindow(tabId, info));
  await chrome.tabs.sendMessage(subscriber, event).catch(async () => {
    // The subscribing page has gone (closed, navigated or reloading without subscribing again).
    const subscribers = (await chrome.storage.session.get(SUBSCRIBERS_KEY))[SUBSCRIBERS_KEY] || {};
    if (subscribers[info.portal] === subscriber) { delete subscribers[info.portal]; await chrome.storage.session.set({ [SUBSCRIBERS_KEY]: subscribers }); }
  });
}

/* ---------------------------------------------------------------------------------------------
 * Tab removal
 * ------------------------------------------------------------------------------------------- */

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(TAB_PREFIX + tabId).catch(() => {});
  chrome.storage.session.get(null).then(stored => {
    const subscribers = stored[SUBSCRIBERS_KEY] || {};
    const left = Object.fromEntries(Object.entries(subscribers).filter(([, id]) => id !== tabId));
    if (Object.keys(left).length !== Object.keys(subscribers).length) chrome.storage.session.set({ [SUBSCRIBERS_KEY]: left });
    Object.keys(stored).filter(key => key.startsWith(APPROVAL_PREFIX) && stored[key].approvalTabId === tabId).forEach(key => {
      const resolve = approvalWaiters.get(key.slice(APPROVAL_PREFIX.length));
      if (resolve) resolve(false); // the approval page was closed without an answer
    });
  }).catch(() => {});
  closeQueue(async () => {
    for (const state of await allCloseStates()) {
      if (tabId === state.confirmTabId) {
        await abortClose(state.requestId, 'the confirmation page was closed');
      } else if (state.waitingTabIds.includes(tabId)) {
        state.waitingTabIds = state.waitingTabIds.filter(id => id !== tabId);
        await chrome.storage.session.set({ [CLOSE_PREFIX + state.requestId]: state });
        if (!state.waitingTabIds.length) await finishClose(state.requestId);
      }
    }
  }).catch(() => {});
});
