/*!
 * secure-session-launcher.js 1.0.0
 * Client for the Secure Session Launcher Chrome extension (interface 1.0). See DEVELOPER-GUIDE.md.
 *
 * The page must carry <meta name="secure-session-launcher" content="portal"> (or "launch"). Load with a
 * <script> tag (global SessionLauncher) or require/import it (CommonJS / AMD). Every request returns a
 * Promise; it rejects with error.code 'no-extension' when the extension does not answer.
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionLauncher = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CHANNEL = 'secure-session-launcher';
  var listeners = {};

  window.addEventListener('message', function (event) {
    var d = event.data;
    if (event.source !== window || event.origin !== location.origin || !d || d.channel !== CHANNEL || d.type !== 'event') return;
    (listeners[d.event] || []).forEach(function (fn) {
      try { fn(d); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
    });
  });

  function request(type, fields, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var requestId = type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      var timer = setTimeout(function () {
        window.removeEventListener('message', onReply);
        var e = new Error('Secure Session Launcher did not answer. Is it installed and enabled?');
        e.code = 'no-extension';
        reject(e);
      }, timeoutMs || 3000);
      function onReply(event) {
        var d = event.data;
        if (event.source !== window || event.origin !== location.origin || !d || d.channel !== CHANNEL
            || d.requestId !== requestId || d.type !== type + '.result') return;
        clearTimeout(timer);
        window.removeEventListener('message', onReply);
        if (d.ok) { resolve(d); return; }
        var e = new Error((d.error && d.error.message) || 'Request failed');
        e.code = d.error && d.error.code;
        reject(e);
      }
      window.addEventListener('message', onReply);
      var message = { channel: CHANNEL, type: type, requestId: requestId };
      Object.keys(fields || {}).forEach(function (k) { message[k] = fields[k]; });
      window.postMessage(message, location.origin);
    });
  }

  /** "1.2.10" vs "1.2.9": negative, 0 or positive. */
  function compareVersions(a, b) {
    var x = String(a).split('.'), y = String(b).split('.');
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var diff = (Number(x[i]) || 0) - (Number(y[i]) || 0);
      if (diff) return diff;
    }
    return 0;
  }

  return {
    VERSION: '1.0.0',
    compareVersions: compareVersions,
    /** {version, approved, incognitoAllowed}. The first request after page load can be missed: retries once. */
    hello: function () {
      return request('hello', {}, 1500).catch(function (e) {
        if (e.code !== 'no-extension') throw e;
        return new Promise(function (r) { setTimeout(r, 300); }).then(function () { return request('hello', {}, 1500); });
      });
    },
    /** Asks the user to approve this site (call from a click). Resolves {approved: true}. */
    requestApproval: function () { return request('requestApproval', {}, 120000); },
    /** {url, app, data, ifOpen, window, closeRequestingTab} -> {outcome: 'opened' | 'confirming' | 'closing'} */
    launch: function (options) { return request('launch', options, 15000); },
    /** Subscribes this page to events, e.g. ['window.focused']. Page must be marked "portal". */
    subscribe: function (events) { return request('events.subscribe', { events: events }, 3000); },
    /** Adds an event handler (event name, function(event)). */
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    /** {front, last}: the launched window in front now, and the one in front most recently (or null). */
    windowInFront: function () { return request('windows.front', {}, 3000); },
    /** Sign-out step 1: switch off "Leave site?" in the windows launched from this portal. */
    prepareSignOut: function () { return request('signOut.prepare', {}, 3000); },
    /** Sign-out step 2: close those windows and clear the launched sites' cookies and stored data. */
    finishSignOut: function () { return request('signOut.finish', {}, 15000); }
  };
}));
