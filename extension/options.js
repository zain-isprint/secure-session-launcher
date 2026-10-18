const sites = document.getElementById('sites');
const error = document.getElementById('error');
const LABELS = { ask: 'Ask (confirmation page)', close: 'Close it and continue', normal: 'Normal window', incognito: 'Incognito window' };

function render(options) {
  document.getElementById('version').textContent = 'v' + options.version;
  document.getElementById('incognito').textContent = options.incognitoAllowed ? 'Allowed' : 'Not allowed';
  document.getElementById('ifOpen').textContent = LABELS[options.defaultIfOpen] || options.defaultIfOpen;
  document.getElementById('windowMode').textContent = LABELS[options.defaultWindow] || options.defaultWindow;
  sites.textContent = '';
  const rows = options.managed.map(origin => ({ origin, by: 'Your organisation', removable: false }))
    .concat(options.approved.filter(o => !options.managed.includes(o)).map(origin => ({ origin, by: 'You', removable: true })));
  if (!rows.length) {
    const tr = sites.insertRow();
    const td = tr.insertCell();
    td.colSpan = 3; td.className = 'muted';
    td.textContent = 'No portals approved yet. A portal asks the first time it needs the extension.';
    return;
  }
  rows.forEach(row => {
    const tr = sites.insertRow();
    const site = tr.insertCell(); site.className = 'origin'; site.textContent = row.origin;
    tr.insertCell().textContent = row.by;
    const action = tr.insertCell(); action.className = 'right';
    if (row.removable) {
      const button = document.createElement('button');
      button.className = 'plain';
      button.textContent = 'Remove';
      button.addEventListener('click', () => call({ kind: 'options-remove', origin: row.origin }));
      action.appendChild(button);
    }
  });
}

function call(message) {
  chrome.runtime.sendMessage(message).then(result => {
    if (!result || result.error) throw new Error(result ? result.error : 'No answer from the extension.');
    render(result);
  }).catch(cause => { error.textContent = cause.message; error.hidden = false; });
}

call({ kind: 'options-get' });
