// Toolbar popup: approve (or remove) the site in the current tab. Only pages that use the extension (they
// carry <meta name="secure-session-launcher">) can be approved here; the extension never asks by itself.
const originEl = document.getElementById('origin');
const state = document.getElementById('state');
const error = document.getElementById('error');
const allow = document.getElementById('allow');
const remove = document.getElementById('remove');

function send(message) {
  return chrome.runtime.sendMessage(message).then(result => {
    if (!result || result.error) throw new Error(result ? result.error : 'No answer from the extension.');
    return result;
  });
}

function fail(message) { error.textContent = message; error.hidden = false; }

async function pageUsesExtension(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { const m = document.querySelector('meta[name="secure-session-launcher"]'); return m ? m.getAttribute('content') : null; }
    });
    return !!(r && r.result);
  } catch { return false; }
}

async function render() {
  allow.hidden = remove.hidden = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin = '';
  try { const u = new URL(tab.url); if (u.protocol === 'https:' || u.protocol === 'http:') origin = u.origin; } catch { /* not a web page */ }
  if (!origin) {
    originEl.textContent = 'This tab';
    state.textContent = 'Open a portal page to approve it here.';
    return;
  }
  originEl.textContent = origin;
  const options = await send({ kind: 'options-get' });
  if (options.managed.includes(origin)) {
    state.textContent = 'Approved by your organisation.';
  } else if (options.approved.includes(origin)) {
    state.textContent = 'Approved by you. This site can open, close and clean up the application windows it launches.';
    remove.hidden = false;
  } else if (await pageUsesExtension(tab.id)) {
    state.textContent = 'This portal uses Secure Session Launcher but is not approved. If you allow it, it can open applications in new '
      + 'windows, close the ones it opened and clear those applications\' sign-in data, and know which of them is in front.';
    allow.hidden = false;
  } else {
    state.textContent = 'This page does not use Secure Session Launcher.';
  }
  allow.onclick = () => {
    allow.disabled = true;
    send({ kind: 'popup-approve', origin }).then(() => chrome.tabs.reload(tab.id)).then(() => window.close())
      .catch(cause => { fail(cause.message); allow.disabled = false; });
  };
  remove.onclick = () => {
    remove.disabled = true;
    send({ kind: 'options-remove', origin }).then(() => chrome.tabs.reload(tab.id)).then(() => window.close())
      .catch(cause => { fail(cause.message); remove.disabled = false; });
  };
}

render().catch(cause => fail(cause.message));
