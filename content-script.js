"use strict";

(() => {
  if (window.__MULTISESSION_TABS_BRIDGE__) return;
  window.__MULTISESSION_TABS_BRIDGE__ = true;

  const PAGE_SOURCE = "multisession-tabs:page";
  const EXT_SOURCE = "multisession-tabs:extension";
  const MSG = {
    SET_COOKIE: "content:setCookie",
    DELETE_COOKIE: "content:deleteCookie",
    GET_COOKIES: "content:getCookies"
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
    handlePageMessage(event.data).catch((error) => {
      postToPage({ id: event.data.id, type: "response", error: error.message || String(error) });
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "content:cookiesUpdated") {
      postToPage({ type: "cookiesUpdated", cookies: message.cookies || [] });
    }
    return false;
  });

  async function handlePageMessage(message) {
    let response;
    if (message.type === "setCookie") {
      response = await saveCookieFromPage(message);
    } else if (message.type === "deleteCookie") {
      response = await deleteCookieFromPage(message);
    } else if (message.type === "getCookies") {
      response = await send({ type: MSG.GET_COOKIES, url: location.href });
    } else {
      response = { ok: false, error: "Unknown page message" };
    }
    postToPage({ id: message.id, type: "response", response });
  }

  async function saveCookieFromPage(message) {
    const cookie = parseSetCookie(message.cookie, message.url || location.href);
    const stored = await chrome.storage.local.get("mst:cookies");
    const all = stored["mst:cookies"] || {};
    const sessionCookies = { ...(all[message.sessionId] || {}) };
    const key = `${cookie.domain};${cookie.path};${cookie.name}`;
    if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) delete sessionCookies[key];
    else sessionCookies[key] = cookie;
    await chrome.storage.local.set({ "mst:cookies": { ...all, [message.sessionId]: sessionCookies } });
    await chrome.storage.session.set({ [`mst:refresh:${message.sessionId}`]: { at: Date.now() } });
    return { ok: true, cookie: publicCookie(cookie) };
  }

  async function deleteCookieFromPage(message) {
    const stored = await chrome.storage.local.get("mst:cookies");
    const all = stored["mst:cookies"] || {};
    const sessionCookies = { ...(all[message.sessionId] || {}) };
    const domain = normalizeCookieDomain(message.domain || location.hostname);
    delete sessionCookies[`${domain};${message.path || "/"};${message.name}`];
    await chrome.storage.local.set({ "mst:cookies": { ...all, [message.sessionId]: sessionCookies } });
    await chrome.storage.session.set({ [`mst:refresh:${message.sessionId}`]: { at: Date.now() } });
    return { ok: true };
  }

  function parseSetCookie(header, sourceUrl) {
    const url = new URL(sourceUrl);
    const parts = String(header).split(";").map((part) => part.trim()).filter(Boolean);
    const [namePart, ...attributes] = parts;
    const eq = namePart.indexOf("=");
    const cookie = {
      name: namePart.slice(0, eq).trim(),
      value: namePart.slice(eq + 1),
      domain: url.hostname.toLowerCase(),
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      expiresAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    for (const attr of attributes) {
      const attrEq = attr.indexOf("=");
      const rawName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).toLowerCase();
      const rawValue = attrEq === -1 ? "" : attr.slice(attrEq + 1);
      if (rawName === "domain") {
        cookie.domain = normalizeCookieDomain(rawValue);
        cookie.hostOnly = false;
      } else if (rawName === "path" && rawValue.startsWith("/")) {
        cookie.path = rawValue;
      } else if (rawName === "secure") {
        cookie.secure = true;
      } else if (rawName === "expires") {
        const time = Date.parse(rawValue);
        cookie.expiresAt = Number.isFinite(time) ? time : null;
      } else if (rawName === "max-age") {
        const seconds = Number.parseInt(rawValue, 10);
        if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
      }
    }
    return cookie;
  }

  function normalizeCookieDomain(domain) {
    return String(domain || "").trim().replace(/^\./, "").toLowerCase();
  }

  function publicCookie(cookie) {
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      hostOnly: cookie.hostOnly,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expiresAt: cookie.expiresAt
    };
  }

  function postToPage(payload) {
    window.postMessage({ source: EXT_SOURCE, ...payload }, "*");
  }

  function send(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
  }

})();
