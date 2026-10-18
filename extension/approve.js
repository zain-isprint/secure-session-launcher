const id = new URLSearchParams(location.search).get('id');
const question = document.getElementById('question');
const error = document.getElementById('error');
const allow = document.getElementById('allow');
const deny = document.getElementById('deny');

function show(message) { error.textContent = message; error.hidden = false; }

function answer(value) {
  allow.disabled = deny.disabled = true;
  chrome.runtime.sendMessage({ kind: 'approval-answer', id, allow: value }).then(result => {
    if (result && result.error) throw new Error(result.error);
    window.close(); // the extension also closes this tab and returns to the portal
  }).catch(cause => { show(cause.message); allow.disabled = deny.disabled = false; });
}

chrome.runtime.sendMessage({ kind: 'approval-get', id }).then(pending => {
  if (!pending || pending.error) throw new Error('This request has expired. Return to the portal and try again.');
  question.textContent = '';
  const site = document.createElement('span');
  site.className = 'origin';
  site.textContent = pending.origin;
  question.append(site, ' is asking to use Secure Session Launcher.');
}).catch(cause => { show(cause.message); allow.disabled = true; });

allow.addEventListener('click', () => answer(true));
deny.addEventListener('click', () => answer(false));
