/*
 * Secure Session Launcher - content script.
 *
 * Relays requests from portal pages to the service worker and posts the replies back. A page takes part
 * only if it carries <meta name="secure-session-launcher" content="portal|launch">; the service worker
 * decides whether the page's site is approved. Also passes events (window.focused) from the service
 * worker to the page, once the page has subscribed.
 *
 * Messages, in both directions, are window.postMessage objects with channel "secure-session-launcher"
 * (see DEVELOPER-GUIDE.md). This script never reads or changes anything else on the page.
 */
(function () {
  'use strict';

  var CHANNEL = 'secure-session-launcher';
  var REQUESTS = ['hello', 'requestApproval', 'launch', 'events.subscribe', 'windows.front', 'signOut.prepare', 'signOut.finish'];
  var subscribed = false;

  function extensionAlive() {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  }

  // Read when a request arrives: this script runs at document_start, before the page is parsed.
  function pageRole() {
    var meta = document.querySelector('meta[name="secure-session-launcher"]');
    var role = meta && String(meta.getAttribute('content') || '').trim().toLowerCase();
    return role === 'portal' || role === 'launch' ? role : null;
  }

  function post(message) {
    window.postMessage(Object.assign({ channel: CHANNEL }, message), location.origin);
  }

  window.addEventListener('message', function (event) {
    var d = event.data;
    if (event.source !== window || event.origin !== location.origin || !d || d.channel !== CHANNEL
            || REQUESTS.indexOf(d.type) < 0 || !extensionAlive()) return;
    var role = pageRole();
    if (!role) return; // not a participating page: stay silent, as if the extension were not installed

    var request = JSON.parse(JSON.stringify(d)); // plain data only
    chrome.runtime.sendMessage({ kind: 'page-request', role: role, request: request }).then(function (reply) {
      reply = reply || { ok: false, error: { code: 'internal', message: 'No answer from the extension.' } };
      if (d.type === 'events.subscribe' && reply.ok) subscribed = true;
      post(Object.assign({}, reply, { type: d.type + '.result', requestId: d.requestId }));
    }).catch(function (error) {
      post({ type: d.type + '.result', requestId: d.requestId, ok: false,
        error: { code: 'internal', message: 'The extension did not answer (' + (error && error.message || 'unknown error') + ').' } });
    });
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.kind !== 'event' || !subscribed) return;
    post({ type: 'event', event: message.event, app: message.app, data: message.data,
      incognito: message.incognito, window: message.window });
  });
})();
