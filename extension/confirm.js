const requestId = new URLSearchParams(location.search).get('id');
const summary = document.getElementById('summary');
const matches = document.getElementById('matches');
const cookieNote = document.getElementById('cookieNote');
const incognitoNote = document.getElementById('incognitoNote');
const error = document.getElementById('error');
const buttons = ['cancel', 'parallel', 'parallelIncognito', 'continue'].map(id => document.getElementById(id));
const [cancelButton, parallelButton, incognitoButton, continueButton] = buttons;

// How long to wait for the old window(s) to close before giving up on this launch.
const CLOSE_WAIT_MS = 2 * 60 * 1000;

function send(message) {
  return chrome.runtime.sendMessage(message).then(result => {
    if (result && result.error) throw new Error(result.error);
    return result;
  });
}

function setBusy(busy) { buttons.forEach(b => { b.disabled = busy; }); }

function fail(message) {
  error.textContent = message;
  error.hidden = false;
  setBusy(false);
}

if (!requestId) {
  fail('This page is missing its request ID. Close it and launch the application again from the portal.');
} else {
  send({ kind: 'get-pending', requestId }).then(pending => {
    if (!pending) throw new Error('This launch request has expired. Return to the portal and try again.');
    summary.textContent = 'The application you launched from ' + pending.portal + ' is already open (' + pending.matchUrl
      + '). Choose what to do with the open window(s):';
    pending.matchingUrls.forEach(url => {
      const item = document.createElement('li');
      item.textContent = url;
      matches.appendChild(item);
    });
    cookieNote.textContent = pending.sameAsPortalHost
      ? 'This application is on the portal\'s own host, so its cookies are not cleared (that would sign you out of the portal); only the window(s) above are closed.'
      : 'Closing clears the cookies of ' + pending.hostname + ' and its parent domains, except cookies the portal also uses, and the site\'s stored data.'
        + (pending.incognito ? ' The application then opens in an incognito window.' : '');
    const notes = [];
    if (!pending.incognitoAllowed) {
      notes.push('Incognito is not allowed for Secure Session Launcher yet: in chrome://extensions, open Details and turn on "Allow in Incognito" '
        + '(also for any sign-on extension the application needs).');
    }
    if (pending.matchingIncognito) notes.push('This application is already open in an incognito window. A new incognito window shares that session.');
    if (notes.length) { incognitoNote.textContent = notes.join(' '); incognitoNote.hidden = false; }
  }).catch(cause => fail(cause.message));
}

cancelButton.addEventListener('click', () => {
  setBusy(true);
  send({ kind: 'cancel-launch', requestId }).then(() => window.close()).catch(cause => fail(cause.message));
});

continueButton.addEventListener('click', () => {
  setBusy(true);
  error.hidden = true;
  send({ kind: 'confirm-launch', requestId }).then(result => {
    if (result && result.waiting) waitForClose();
    else window.close();
  }).catch(cause => fail(cause.message));
});

// The old windows are closing. The extension closes this page itself when the new window opens, or when
// the user keeps an old window (Cancel on a "Leave site?" prompt the extension could not switch off).
function waitForClose() {
  summary.textContent = 'Closing the open window(s)... If the application still asks "Leave site?", choose Leave to continue, '
    + 'or Cancel to keep it open (this launch is then cancelled).';
  cancelButton.disabled = false;
  setTimeout(() => { send({ kind: 'cancel-launch', requestId }).finally(() => window.close()); }, CLOSE_WAIT_MS);
}

function launchParallel(incognito) {
  setBusy(true);
  error.hidden = true;
  send({ kind: 'launch-parallel', requestId, incognito }).then(() => window.close()).catch(cause => fail(cause.message));
}
parallelButton.addEventListener('click', () => launchParallel(false));
incognitoButton.addEventListener('click', () => launchParallel(true));
