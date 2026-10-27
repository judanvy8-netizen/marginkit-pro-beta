/** Optional, local-only diagnostics. No network calls or persistent visitor ID. */
(function (global) {
  'use strict';
  var CONSENT = 'orvantro_local_analytics_enabled_v2';
  var STORE = 'orvantro_local_analytics_v2';
  var LIMIT = 800;
  var RETENTION = 30 * 24 * 60 * 60 * 1000;
  var SITES = ['orvantro', 'orvantro-insights', 'marginkit-pro-beta', 'markit-pro-beta', 'feeroi', 'sellerbill'];
  var configured = (global.ORVANTRO_ANALYTICS || {}).site;
  var site = SITES.indexOf(configured) >= 0 ? configured : 'unknown';
  var pageRecorded = false;

  function isEnabled() {
    try { return localStorage.getItem(CONSENT) === 'yes'; } catch (e) { return false; }
  }
  function route(name) { return name === 'orvantro' ? '/' : '/' + name + '/'; }
  function read() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw || raw.length > 500000) return [];
      var rows = JSON.parse(raw);
      if (!Array.isArray(rows)) return [];
      var now = Date.now();
      var clean = rows.slice(-LIMIT).filter(function (e) {
        return e && Number.isFinite(e.t) && e.t >= now - RETENTION && e.t <= now &&
          e.type === 'orvantro_pageview' && SITES.indexOf(e.site) >= 0;
      }).map(function (e) {
        return { t: e.t, type: 'orvantro_pageview', site: e.site, path: route(e.site) };
      });
      var encoded = JSON.stringify(clean);
      if (encoded !== raw) {
        try {
          if (clean.length) localStorage.setItem(STORE, encoded);
          else localStorage.removeItem(STORE);
        } catch (ignore) { /* Read-only/private-mode storage cannot be pruned. */ }
      }
      return clean;
    } catch (e) { return []; }
  }
  function recordPage() {
    if (!isEnabled() || pageRecorded || site === 'unknown') return false;
    var events = read();
    events.push({ t: Date.now(), type: 'orvantro_pageview', site: site, path: route(site) });
    try {
      localStorage.setItem(STORE, JSON.stringify(events.slice(-LIMIT)));
      pageRecorded = true;
      return true;
    } catch (e) { return false; }
  }
  function setEnabled(enabled) {
    try {
      if (enabled === true) localStorage.setItem(CONSENT, 'yes');
      else localStorage.removeItem(CONSENT);
    } catch (e) { return false; }
    read();
    if (enabled === true) recordPage();
    return isEnabled();
  }
  function clearRing() {
    var success = true;
    ['orvantro_local_analytics_v2', 'orvantro_analytics_ring', 'orvantro_vid', 'orvantro_first_seen',
      'orvantro_insights_import', 'orvantro_amp_creds'].forEach(function (key) {
      try { localStorage.removeItem(key); } catch (e) { success = false; }
    });
    ['orvantro_sid', 'orvantro_session_started'].forEach(function (key) {
      try { sessionStorage.removeItem(key); } catch (e) { success = false; }
    });
    // Old builds stored identifying events in IndexedDB. Delete only that database.
    if (!global.indexedDB) return Promise.resolve(success);
    return new Promise(function (resolve) {
      try {
        var request = global.indexedDB.deleteDatabase('orvantro_analytics');
        request.onsuccess = function () { resolve(success); };
        request.onerror = request.onblocked = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }
  global.OrvantroAnalytics = {
    site: site,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    track: function (name) {
      // Caller properties are deliberately discarded; no URLs or free-form data.
      return name === 'pageview' || name === 'orvantro_pageview' ? recordPage() : false;
    },
    getRing: read,
    getStore: function () { return Promise.resolve(read()); },
    clearRing: clearRing
  };
  global.addEventListener('storage', function (event) {
    if (event.key === CONSENT && isEnabled()) recordPage();
  });
  function boot() { read(); recordPage(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : this);
