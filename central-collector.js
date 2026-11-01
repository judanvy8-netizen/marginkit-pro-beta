/* First-party central measurement, separate from optional local diagnostics */
(function (w) {
  'use strict';
  var cfg = w.ORVANTRO_CENTRAL || {};
  var CONSENT = 'orvantro_central_consent_v2:' + cfg.site;
  var SESSION = 'orvantro_central_tab_session_v2:' + cfg.site;
  var TTL = 30 * 60 * 1000;
  var sites = ['orvantro', 'orvantro-insights', 'marginkit-pro-beta'];
  var sent = false, pending = false, attempted = false, result = null;

  function endpoint() {
    try {
      var url = new URL(cfg.endpoint);
      if (url.protocol !== 'https:' || url.pathname !== '/collect' || url.search || url.hash || url.username || url.password) return '';
      return url.href;
    } catch (_) { return ''; }
  }
  function allowed() {
    return cfg.enabled === true && sites.indexOf(cfg.site) !== -1 && !!endpoint();
  }
  function privacyBlocked() {
    return w.navigator.globalPrivacyControl === true || w.navigator.doNotTrack === '1' || w.doNotTrack === '1';
  }
  function consent() {
    try { return w.localStorage.getItem(CONSENT) === 'yes'; } catch (_) { return false; }
  }
  function status() {
    if (!allowed()) return 'not-configured';
    if (privacyBlocked()) return 'privacy-preference';
    if (!consent()) return 'needs-consent';
    return result || (pending ? 'sending' : sent ? 'sent' : 'ready');
  }
  function changed() {
    if (typeof w.CustomEvent === 'function') w.dispatchEvent(new w.CustomEvent('orvantro-central-status', { detail: { status: status() } }));
  }
  function uuid() {
    if (!w.crypto || typeof w.crypto.randomUUID !== 'function') throw Error('secure-random-unavailable');
    return w.crypto.randomUUID();
  }
  function session() {
    var now = Date.now(), current;
    try { current = JSON.parse(w.sessionStorage.getItem(SESSION) || 'null'); } catch (_) { current = null; }
    if (!current || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(current.id) ||
        !Number.isFinite(current.last) || current.last > now || now - current.last >= TTL) {
      current = { id: uuid(), last: now };
    }
    current.last = now;
    w.sessionStorage.setItem(SESSION, JSON.stringify(current));
    return current.id;
  }
  async function record() {
    if (!allowed() || privacyBlocked() || !consent() || attempted || sent || pending || w.document.visibilityState === 'hidden' || w.document.prerendering) return false;
    pending = true;
    result = null;
    changed();
    try {
      var body = JSON.stringify({ v: 2, site: cfg.site, eventId: uuid(), sessionId: session() });
      attempted = true;
      // No URL, query string, page title, referrer, product data or credentials leave the page
      var response = await w.fetch(endpoint(), {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: body,
        credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', keepalive: true
      });
      if (!response.ok) throw Error('collection-unavailable');
      var acknowledgement = await response.json();
      if (!acknowledgement || acknowledgement.accepted !== true) {
        result = acknowledgement && acknowledgement.reason === 'privacy_preference' ? 'privacy-preference' : 'error';
        return false;
      }
      sent = true;
      result = 'sent';
      return true;
    } catch (_) {
      result = 'error';
      return false;
    } finally { pending = false; changed(); }
  }
  function setConsent(value) {
    try {
      if (value === true) w.localStorage.setItem(CONSENT, 'yes');
      else {
        w.localStorage.removeItem(CONSENT);
        w.sessionStorage.removeItem(SESSION);
      }
    } catch (_) { result = 'storage-unavailable'; changed(); return false; }
    changed();
    if (value === true) record();
    return consent();
  }
  w.OrvantroCentral = {
    getStatus: function () { return { status: status(), configured: allowed(), consent: consent(), respectsPrivacyPreference: privacyBlocked() }; },
    setConsent: setConsent
  };
  w.document.addEventListener('visibilitychange', record);
  w.document.addEventListener('prerenderingchange', record);
  w.addEventListener('storage', function (event) { if (event.key === CONSENT) { changed(); record(); } });
  if (w.document.readyState === 'loading') w.document.addEventListener('DOMContentLoaded', record);
  else record();
})(window);
