/**
 * Lightweight UI error reporter: window errors, unhandled rejections, fetch failures.
 * Never throws; send failures are silent. Uses native fetch saved before optional wrap.
 */
(function (w) {
  var ENDPOINT = "/api/ui-errors";
  var DEDUPE_MS = 45000;
  var SESSION_CAP = 40;
  var SESSION_WINDOW_MS = 600000;
  var dedupe = Object.create(null);
  var sessionStart = Date.now();
  var sessionSends = 0;

  function readPageContext() {
    var b = w.document && w.document.body;
    if (!b || !b.dataset) return {};
    var out = {};
    if (b.dataset.uiUserId) out.userId = String(b.dataset.uiUserId);
    if (b.dataset.uiRole) out.role = String(b.dataset.uiRole);
    if (b.dataset.uiPropertyId) out.propertyId = String(b.dataset.uiPropertyId).slice(0, 64);
    if (b.dataset.uiHotelSlug) out.hotelSlug = String(b.dataset.uiHotelSlug).slice(0, 120);
    var hid = w.document.querySelector('input[name="propertyId"]');
    if (hid && hid.value) out.propertyId = String(hid.value).slice(0, 64);
    return out;
  }

  function dedupeKey(type, message, pathname) {
    return String(type || "") + "|" + String(message || "").slice(0, 200) + "|" + String(pathname || "");
  }

  function shouldSend(type, message, pathname) {
    var now = Date.now();
    if (now - sessionStart > SESSION_WINDOW_MS) {
      sessionStart = now;
      sessionSends = 0;
    }
    if (sessionSends >= SESSION_CAP) return false;
    var k = dedupeKey(type, message, pathname);
    var last = dedupe[k];
    if (last && now - last < DEDUPE_MS) return false;
    dedupe[k] = now;
    sessionSends += 1;
    return true;
  }

  var nativeFetch = typeof w.fetch === "function" ? w.fetch.bind(w) : null;

  function buildPayload(partial) {
    var loc = w.location || {};
    var base = {
      type: partial.type || "manual",
      message: String(partial.message || "").slice(0, 2000),
      stack: partial.stack ? String(partial.stack).slice(0, 8000) : undefined,
      url: String(loc.href || "").slice(0, 2000),
      pathname: String(loc.pathname || "").slice(0, 500),
      userAgent: typeof navigator !== "undefined" ? String(navigator.userAgent || "").slice(0, 500) : undefined,
      timestamp: new Date().toISOString(),
      feature: partial.feature ? String(partial.feature).slice(0, 200) : undefined,
      context: undefined
    };
    var ctx = Object.assign({}, readPageContext(), partial.context && typeof partial.context === "object" ? partial.context : {});
    var keys = Object.keys(ctx);
    if (keys.length) base.context = ctx;
    return base;
  }

  function sendPayload(payload) {
    try {
      var body = JSON.stringify(payload);
      if (nativeFetch) {
        nativeFetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          credentials: "same-origin",
          body: body,
          keepalive: true
        }).catch(function () {});
        return;
      }
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        var blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon(ENDPOINT, blob);
      }
    } catch (e) {}
  }

  function trackUIError(partial) {
    try {
      if (!partial || typeof partial !== "object") return;
      var type = partial.type || "manual";
      var message = String(partial.message || "");
      var pathname = (w.location && w.location.pathname) || "";
      if (!shouldSend(type, message, pathname)) return;
      sendPayload(buildPayload(partial));
    } catch (e) {}
  }

  w.trackUIError = trackUIError;

  w.addEventListener(
    "error",
    function (ev) {
      try {
        var err = ev.error;
        var msg = ev.message || (err && err.message) || "script error";
        var stack = err && err.stack ? String(err.stack) : undefined;
        trackUIError({ type: "window_error", message: String(msg), stack: stack, feature: "global" });
      } catch (e) {}
    },
    true
  );

  w.addEventListener("unhandledrejection", function (ev) {
    try {
      var reason = ev.reason;
      var msg =
        reason && typeof reason === "object" && reason.message
          ? String(reason.message)
          : String(reason != null ? reason : "unhandled rejection");
      var stack = reason && typeof reason === "object" && reason.stack ? String(reason.stack) : undefined;
      trackUIError({ type: "unhandled_rejection", message: msg, stack: stack, feature: "global" });
    } catch (e) {}
  });

  if (nativeFetch) {
    w.fetch = function (input, init) {
      var method = "GET";
      var path = "";
      try {
        if (typeof input === "string") {
          var u = new URL(input, w.location.origin);
          path = u.pathname;
          method = (init && init.method) || "GET";
        } else if (input && typeof input === "object" && "url" in input) {
          var u2 = new URL(String(input.url), w.location.origin);
          path = u2.pathname;
          method = (init && init.method) || String(input.method || "GET");
        }
      } catch (e) {
        path = "";
      }
      if (path.indexOf("/api/ui-errors") === 0) {
        return nativeFetch(input, init);
      }
      return nativeFetch(input, init).then(
        function (res) {
          try {
            if (!res.ok && (res.status >= 500 || res.status === 0)) {
              trackUIError({
                type: "api_error",
                message: "HTTP " + String(res.status),
                feature: "fetch",
                context: { method: String(method).toUpperCase().slice(0, 16), path: String(path).slice(0, 500), status: res.status }
              });
            }
          } catch (e) {}
          return res;
        },
        function (err) {
          try {
            trackUIError({
              type: "api_error",
              message: "network error",
              feature: "fetch",
              context: {
                method: String(method).toUpperCase().slice(0, 16),
                path: String(path).slice(0, 500),
                status: 0,
                detail: err && err.message ? String(err.message).slice(0, 300) : undefined
              }
            });
          } catch (e2) {}
          return Promise.reject(err);
        }
      );
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
