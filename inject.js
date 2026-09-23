// Runs in the page's own JS context ("MAIN" world).
// It never talks to the network itself - it just watches the requests the
// GHL app already makes, and republishes:
//   1) the auth token / locationId / companyId it sees (for the export/
//      import features), and
//   2) a live log of every relevant request+response (method, url, body),
//      so we can discover new endpoints (e.g. WhatsApp templates) without
//      opening DevTools by hand.
(function () {
  if (window.__ghlWfHooked) return;
  window.__ghlWfHooked = true;

  const RELEVANT = (url) =>
    typeof url === "string" &&
    (url.includes("leadconnectorhq.com") ||
      url.includes("facebook.com") ||
      url.includes("firebasestorage.googleapis.com"));

  function publish(type, partial) {
    window.postMessage({ source: "ghl-wf-tool", type, ...partial }, "*");
  }

  function truncate(v, max) {
    try {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      if (!s) return s;
      return s.length > max ? s.slice(0, max) + `...(${s.length} chars total)` : s;
    } catch (e) {
      return String(v);
    }
  }

  function logEntry(entry) {
    publish("network-log", { entry });
  }

  function extractFromUrl(url) {
    const m = url.match(/\/workflow\/([^/?]+)/);
    if (m) publish("creds", { locationId: m[1] });
  }

  function extractFromBody(bodyStr) {
    if (!bodyStr || typeof bodyStr !== "string") return;
    const loc = bodyStr.match(/"locationId":"([^"]+)"/);
    const comp = bodyStr.match(/"companyId":"([^"]+)"/) || bodyStr.match(/"company_id":"([^"]+)"/);
    if (loc || comp) {
      publish("creds", {
        locationId: loc ? loc[1] : undefined,
        companyId: comp ? comp[1] : undefined,
      });
    }
  }

  function getAuthHeader(input, init) {
    try {
      if (init && init.headers) {
        const h = init.headers;
        if (h instanceof Headers) return h.get("authorization") || h.get("Authorization");
        if (typeof h === "object") return h["authorization"] || h["Authorization"];
      }
      if (input instanceof Request) {
        return input.headers.get("authorization") || input.headers.get("Authorization");
      }
    } catch (e) {}
    return null;
  }

  // The email-builder endpoints (/emails/builder/*) require a second,
  // separately-rotating Firebase JWT sent as "token-id" - distinct from the
  // main "Authorization" bearer used everywhere else. Capture it the same way.
  function getTokenIdHeader(input, init) {
    try {
      if (init && init.headers) {
        const h = init.headers;
        if (h instanceof Headers) return h.get("token-id");
        if (typeof h === "object") return h["token-id"] || h["Token-Id"] || h["Token-ID"];
      }
      if (input instanceof Request) {
        return input.headers.get("token-id");
      }
    } catch (e) {}
    return null;
  }

  // Returns a plain {name: value} map of every header the page actually
  // sent, so we can compare against what our own replicated calls send when
  // something 401s for no obvious reason.
  function getAllHeaders(input, init) {
    const out = {};
    try {
      let h = init && init.headers;
      if (!h && input instanceof Request) h = input.headers;
      if (h instanceof Headers) {
        for (const [k, v] of h.entries()) out[k] = k.toLowerCase() === "authorization" ? "Bearer <redactado>" : v;
      } else if (h && typeof h === "object") {
        for (const k of Object.keys(h)) out[k] = k.toLowerCase() === "authorization" ? "Bearer <redactado>" : h[k];
      }
    } catch (e) {}
    return out;
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const method = (init && init.method) || (input instanceof Request && input.method) || "GET";
    const reqBody = init && typeof init.body === "string" ? init.body : null;
    const reqHeaders = getAllHeaders(input, init);
    const relevant = RELEVANT(url);
    const startedAt = Date.now();

    try {
      if (relevant) {
        const auth = getAuthHeader(input, init);
        if (auth) publish("creds", { token: auth });
        const tokenId = getTokenIdHeader(input, init);
        if (tokenId) publish("creds", { tokenId });
        extractFromUrl(url);
        if (reqBody) extractFromBody(reqBody);
      }
    } catch (e) {}

    const promise = origFetch.apply(this, arguments);

    if (relevant) {
      promise
        .then((res) => {
          res
            .clone()
            .text()
            .then((bodyText) => {
              logEntry({
                ts: new Date().toISOString(),
                method,
                url,
                status: res.status,
                reqHeaders,
                reqBody: truncate(reqBody, 4000),
                resBody: truncate(bodyText, 4000),
                ms: Date.now() - startedAt,
              });
            })
            .catch(() => {
              logEntry({
                ts: new Date().toISOString(),
                method,
                url,
                status: res.status,
                reqHeaders,
                reqBody: truncate(reqBody, 4000),
                resBody: "<no se pudo leer el body>",
                ms: Date.now() - startedAt,
              });
            });
        })
        .catch((err) => {
          logEntry({
            ts: new Date().toISOString(),
            method,
            url,
            status: "ERR",
            reqHeaders,
            reqBody: truncate(reqBody, 4000),
            resBody: String(err),
            ms: Date.now() - startedAt,
          });
        });
    }

    return promise;
  };

  // ---- XMLHttpRequest ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ghlWfUrl = url;
    this.__ghlWfMethod = method;
    this.__ghlWfStart = Date.now();
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (RELEVANT(this.__ghlWfUrl)) {
      this.__ghlWfHeaders = this.__ghlWfHeaders || {};
      this.__ghlWfHeaders[name] = /^authorization$/i.test(name) ? "Bearer <redactado>" : value;
      if (/^authorization$/i.test(name)) publish("creds", { token: value });
      if (/^token-id$/i.test(name)) publish("creds", { tokenId: value });
    }
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (RELEVANT(this.__ghlWfUrl)) {
      extractFromUrl(this.__ghlWfUrl);
      if (typeof body === "string") extractFromBody(body);
      this.addEventListener("loadend", () => {
        logEntry({
          ts: new Date().toISOString(),
          method: this.__ghlWfMethod,
          url: this.__ghlWfUrl,
          status: this.status,
          reqHeaders: this.__ghlWfHeaders || {},
          reqBody: truncate(typeof body === "string" ? body : null, 4000),
          resBody: truncate(this.responseText, 4000),
          ms: Date.now() - this.__ghlWfStart,
        });
      });
    }
    return origSend.apply(this, arguments);
  };
})();
