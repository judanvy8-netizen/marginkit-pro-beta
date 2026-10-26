/**
 * ORVANTRO first-party visitor analytics (zero user-configured keys)
 *
 * Write paths (all baked-in, no secrets to paste):
 *  1) IndexedDB + localStorage ring — primary store for Insights on same origin
 *  2) Abacus public counters — coarse global aggregates (no auth)
 *  3) Amplitude HTTP API — optional public write key (baked-in); never requires
 *     the operator to paste a secret for Insights to work
 *
 * Privacy: no payment/PII payloads. Config:
 *   window.ORVANTRO_ANALYTICS = { site: 'orvantro' } before this script.
 */
(function (global) {
  'use strict';

  var AMP_KEY = 'b2e96892ba576e2c846c4fbe57e4c494';
  var AMP_URL = 'https://api2.amplitude.com/2/httpapi';
  var ABACUS_BASE = 'https://abacus.jasoncameron.dev';
  var GEO_URLS = [
    'https://get.geojs.io/v1/ip/geo.json',
    'https://ipwho.is/'
  ];
  var LS_VID = 'orvantro_vid';
  var LS_FIRST = 'orvantro_first_seen';
  var LS_RING = 'orvantro_analytics_ring';
  var SS_SID = 'orvantro_sid';
  var SS_STARTED = 'orvantro_session_started';
  var RING_MAX = 800;
  var IDB_NAME = 'orvantro_analytics';
  var IDB_STORE = 'events';
  var IDB_VERSION = 1;
  var HEARTBEAT_MS = 15000;

  var cfg = global.ORVANTRO_ANALYTICS || {};
  var site = String(cfg.site || guessSite() || 'unknown').toLowerCase();

  function guessSite() {
    try {
      var p = (location.pathname || '').toLowerCase();
      var host = (location.hostname || '').toLowerCase();
      var parts = p.split('/').filter(Boolean);
      var known = ['orvantro', 'orvantro-insights', 'insights', 'markit-pro-beta', 'marginkit-pro-beta', 'feeroi', 'sellerbill'];
      for (var i = 0; i < parts.length; i++) {
        if (known.indexOf(parts[i]) >= 0) return parts[i] === 'insights' ? 'orvantro-insights' : parts[i];
      }
      if (host.indexOf('orvantro.com') >= 0) return 'orvantro';
    } catch (e) { /* ignore */ }
    return 'unknown';
  }

  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'ov-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function getVisitor() {
    var id = null;
    var firstSeen = null;
    try {
      id = localStorage.getItem(LS_VID);
      firstSeen = localStorage.getItem(LS_FIRST);
      if (!id) {
        id = uuid();
        firstSeen = String(Date.now());
        localStorage.setItem(LS_VID, id);
        localStorage.setItem(LS_FIRST, firstSeen);
      } else if (!firstSeen) {
        firstSeen = String(Date.now());
        localStorage.setItem(LS_FIRST, firstSeen);
      }
    } catch (e) {
      id = id || uuid();
      firstSeen = firstSeen || String(Date.now());
    }
    var returning = false;
    try {
      returning = Number(firstSeen) < Date.now() - 30 * 60 * 1000;
      var fs = new Date(Number(firstSeen));
      var now = new Date();
      if (fs.toDateString() !== now.toDateString() || Number(firstSeen) < Date.now() - 60 * 60 * 1000) {
        returning = true;
      }
      if (Date.now() - Number(firstSeen) < 2000) returning = false;
    } catch (e2) { /* ignore */ }
    return { id: id, firstSeen: Number(firstSeen) || Date.now(), returning: returning };
  }

  function getSessionId() {
    try {
      var sid = sessionStorage.getItem(SS_SID);
      if (!sid) {
        sid = uuid();
        sessionStorage.setItem(SS_SID, sid);
      }
      return sid;
    } catch (e) {
      return uuid();
    }
  }

  function utmParams() {
    var out = {};
    try {
      var q = new URLSearchParams(location.search || '');
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) {
        var v = q.get(k);
        if (v) out[k] = v;
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  function deviceProps() {
    var w = global.innerWidth || 0;
    var h = global.innerHeight || 0;
    var ua = (navigator.userAgent || '').toLowerCase();
    var type = 'desktop';
    if (/ipad|tablet/.test(ua)) type = 'tablet';
    else if (/mobi|iphone|android/.test(ua)) type = 'mobile';
    return {
      device_type: type,
      viewport_w: w,
      viewport_h: h,
      language: navigator.language || '',
      languages: (navigator.languages || []).slice(0, 3).join(','),
      timezone: (function () {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
      })(),
      tz_offset_min: new Date().getTimezoneOffset()
    };
  }

  /* ---------- IndexedDB + localStorage ring ---------- */

  var idb = null;
  var idbReady = null;

  function openIdb() {
    if (idbReady) return idbReady;
    idbReady = new Promise(function (resolve) {
      if (!global.indexedDB) {
        resolve(null);
        return;
      }
      try {
        var req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            var store = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
            store.createIndex('t', 't', { unique: false });
            store.createIndex('site', 'site', { unique: false });
            store.createIndex('type', 'type', { unique: false });
          }
        };
        req.onsuccess = function () {
          idb = req.result;
          resolve(idb);
        };
        req.onerror = function () { resolve(null); };
      } catch (e) {
        resolve(null);
      }
    });
    return idbReady;
  }

  function idbPut(record) {
    return openIdb().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).add(record);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    });
  }

  function idbTrim() {
    return openIdb().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          var store = tx.objectStore(IDB_STORE);
          var countReq = store.count();
          countReq.onsuccess = function () {
            var n = countReq.result || 0;
            if (n <= RING_MAX * 2) {
              resolve();
              return;
            }
            var extra = n - RING_MAX;
            var idx = store.index('t');
            var cursorReq = idx.openCursor();
            cursorReq.onsuccess = function () {
              var cursor = cursorReq.result;
              if (cursor && extra > 0) {
                cursor.delete();
                extra -= 1;
                cursor.continue();
              }
            };
            tx.oncomplete = function () { resolve(); };
          };
          countReq.onerror = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    });
  }

  function idbGetAll() {
    return openIdb().then(function (db) {
      if (!db) return [];
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readonly');
          var req = tx.objectStore(IDB_STORE).getAll();
          req.onsuccess = function () {
            var rows = req.result || [];
            rows.sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
            resolve(rows);
          };
          req.onerror = function () { resolve([]); };
        } catch (e) { resolve([]); }
      });
    });
  }

  function pushRing(evt) {
    try {
      var raw = localStorage.getItem(LS_RING);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) arr = [];
      arr.push(evt);
      if (arr.length > RING_MAX) arr = arr.slice(arr.length - RING_MAX);
      localStorage.setItem(LS_RING, JSON.stringify(arr));
    } catch (e) { /* quota / private mode */ }
    idbPut(evt).then(function () { return idbTrim(); }).catch(function () {});
  }

  function readLocalRingSync() {
    try {
      var raw = localStorage.getItem(LS_RING);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function mergeEvents(a, b) {
    var map = {};
    function key(e) {
      return [e.t, e.type, e.site, e.path, e.visitor_id || ''].join('|');
    }
    (a || []).concat(b || []).forEach(function (e) {
      if (!e || !e.t) return;
      map[key(e)] = e;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (x, y) { return x.t - y.t; });
  }

  /* ---------- Free write paths (no user keys) ---------- */

  function sendAmplitude(events) {
    if (!events || !events.length || !AMP_KEY) return;
    var body = JSON.stringify({ api_key: AMP_KEY, events: events });
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(AMP_URL, blob)) return;
      }
    } catch (e) { /* fall through */ }
    try {
      fetch(AMP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: '*/*' },
        body: body,
        keepalive: true,
        mode: 'cors'
      }).catch(function () { /* analytics optional */ });
    } catch (e2) { /* ignore */ }
  }

  function bumpAbacus(counter) {
    var url = ABACUS_BASE + '/hit/orvantro/' + encodeURIComponent(counter);
    try {
      fetch(url, { mode: 'cors', keepalive: true }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  var geoCache = null;
  var geoPromise = null;

  function fetchGeo() {
    if (geoCache) return Promise.resolve(geoCache);
    if (geoPromise) return geoPromise;
    geoPromise = (async function () {
      for (var i = 0; i < GEO_URLS.length; i++) {
        try {
          var res = await fetch(GEO_URLS[i], { mode: 'cors' });
          if (!res.ok) continue;
          var data = await res.json();
          var mapped = normalizeGeo(data);
          if (mapped && mapped.country_code) {
            geoCache = mapped;
            return geoCache;
          }
        } catch (e) { /* try next */ }
      }
      geoCache = { country: '', country_code: '', region: '', city: '', source: 'unavailable' };
      return geoCache;
    })();
    return geoPromise;
  }

  function normalizeGeo(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.country_code || data.country) {
      return {
        country: data.country || '',
        country_code: (data.country_code || '').toUpperCase(),
        region: data.region || data.region_name || '',
        city: data.city || '',
        source: data.success !== false && data.country_code && !data.region_name ? (data.city && data.region ? 'ipwho' : 'geojs') : 'geojs'
      };
    }
    if (data.success !== false && (data.country_code || data.country)) {
      return {
        country: data.country || '',
        country_code: (data.country_code || '').toUpperCase(),
        region: data.region || '',
        city: data.city || '',
        source: 'ipwho'
      };
    }
    return null;
  }

  var visitor = getVisitor();
  var sessionId = getSessionId();
  var engagedMs = 0;
  var lastBeat = Date.now();
  var visible = !document.hidden;
  var pathSeq = [];

  function baseProps(extra) {
    var utm = utmParams();
    var dev = deviceProps();
    var props = {
      site: site,
      path: location.pathname || '/',
      href: location.href,
      host: location.hostname || '',
      title: document.title || '',
      referrer: document.referrer || '',
      visitor_returning: visitor.returning,
      first_seen: visitor.firstSeen,
      session_id: sessionId,
      language: dev.language,
      timezone: dev.timezone,
      device_type: dev.device_type,
      viewport_w: dev.viewport_w,
      viewport_h: dev.viewport_h
    };
    Object.keys(utm).forEach(function (k) { props[k] = utm[k]; });
    if (extra) Object.keys(extra).forEach(function (k) { props[k] = extra[k]; });
    return props;
  }

  function emit(eventType, extra) {
    var props = baseProps(extra);
    if (geoCache) {
      props.country = geoCache.country;
      props.country_code = geoCache.country_code;
      props.region = geoCache.region;
      props.city = geoCache.city;
      props.geo_source = geoCache.source;
    }
    var evt = {
      user_id: visitor.id,
      device_id: visitor.id,
      event_type: eventType,
      time: Date.now(),
      session_id: sessionId,
      platform: 'Web',
      language: props.language,
      event_properties: props,
      user_properties: {
        orvantro_site_last: site,
        orvantro_returning: visitor.returning,
        orvantro_first_seen: visitor.firstSeen,
        country_code: props.country_code || undefined
      }
    };
    var ringRec = {
      t: evt.time,
      type: eventType,
      site: site,
      path: props.path,
      returning: visitor.returning,
      country_code: props.country_code || '',
      country: props.country || '',
      region: props.region || '',
      city: props.city || '',
      device_type: props.device_type,
      referrer: props.referrer,
      utm_source: props.utm_source || '',
      utm_medium: props.utm_medium || '',
      utm_campaign: props.utm_campaign || '',
      engaged_ms: props.engaged_ms || 0,
      visitor_id: visitor.id,
      session_id: sessionId,
      first_seen: visitor.firstSeen,
      title: props.title || '',
      language: props.language || '',
      timezone: props.timezone || ''
    };
    pushRing(ringRec);
    sendAmplitude([evt]);
    return evt;
  }

  function trackPageview() {
    var path = location.pathname || '/';
    pathSeq.push(path);
    if (pathSeq.length > 12) pathSeq = pathSeq.slice(-12);
    emit('orvantro_pageview', { path_depth: pathSeq.length, path_seq: pathSeq.join('>') });
    bumpAbacus('pageviews');
    bumpAbacus('pv_' + site);
    bumpAbacus('day_' + dayStamp());
    if (visitor.returning) bumpAbacus('returning');
    else bumpAbacus('unique_first');
    if (geoCache && geoCache.country_code) {
      bumpAbacus('cc_' + geoCache.country_code.toLowerCase());
    }
  }

  function dayStamp() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + m + day;
  }

  function maybeSessionStart() {
    try {
      if (sessionStorage.getItem(SS_STARTED)) return;
      sessionStorage.setItem(SS_STARTED, '1');
    } catch (e) { /* continue */ }
    emit('orvantro_session_start');
    bumpAbacus('sessions');
  }

  function onHeartbeat() {
    if (!visible) {
      lastBeat = Date.now();
      return;
    }
    var now = Date.now();
    var delta = Math.min(now - lastBeat, HEARTBEAT_MS + 2000);
    lastBeat = now;
    if (delta > 0) engagedMs += delta;
    emit('orvantro_heartbeat', { engaged_ms: engagedMs, heartbeat_delta_ms: delta });
  }

  function onVisibility() {
    visible = !document.hidden;
    lastBeat = Date.now();
    if (document.hidden) {
      emit('orvantro_engage', { engaged_ms: engagedMs, state: 'hidden' });
    }
  }

  function onUnload() {
    emit('orvantro_engage', { engaged_ms: engagedMs, state: 'unload' });
  }

  global.OrvantroAnalytics = {
    site: site,
    visitorId: visitor.id,
    firstSeen: visitor.firstSeen,
    returning: visitor.returning,
    sessionId: sessionId,
    track: function (name, extra) {
      emit('orvantro_' + String(name || 'custom').replace(/^orvantro_/, ''), extra || {});
    },
    getRing: function () {
      return readLocalRingSync();
    },
    getStore: function () {
      return idbGetAll().then(function (rows) {
        return mergeEvents(readLocalRingSync(), rows);
      });
    },
    clearRing: function () {
      try { localStorage.removeItem(LS_RING); } catch (e) { /* ignore */ }
      return openIdb().then(function (db) {
        if (!db) return;
        return new Promise(function (resolve) {
          try {
            var tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { resolve(); };
          } catch (e2) { resolve(); }
        });
      });
    },
    fetchAbacus: function (counter) {
      return fetch(ABACUS_BASE + '/get/orvantro/' + encodeURIComponent(counter), { mode: 'cors' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
  };

  function boot() {
    openIdb();
    maybeSessionStart();
    fetchGeo().then(function () {
      trackPageview();
    }).catch(function () {
      trackPageview();
    });
    setInterval(onHeartbeat, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', onVisibility);
    global.addEventListener('pagehide', onUnload);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : this);
