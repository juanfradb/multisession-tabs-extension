"use strict";

const MSG = {
  GET_STATE: "popup:getState",
  CREATE_SESSION: "session:create",
  OPEN_SESSION: "session:open",
  ASSIGN_TAB: "tab:assign",
  CLEAR_TAB: "tab:clear",
  CONTENT_SET_COOKIE: "content:setCookie",
  CONTENT_DELETE_COOKIE: "content:deleteCookie",
  CONTENT_GET_COOKIES: "content:getCookies"
};

const LOCAL_SESSIONS = "mst:sessions";
const LOCAL_COOKIES = "mst:cookies";
const TAB_PREFIX = "mst:tab:";
const RULE_PREFIX = "mst:rules:";
const REFRESH_PREFIX = "mst:refresh:";
const tabRuleQueues = new Map();
const pendingTabAssignments = new Map();
const COLORS = ["#1d4ed8", "#047857", "#b45309", "#be123c", "#6d28d9", "#0f766e"];
const RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "other"
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => {
    console.error(error);
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session") return;
  for (const [key, change] of Object.entries(changes)) {
    if (key.startsWith(TAB_PREFIX)) {
      const tabId = Number(key.slice(TAB_PREFIX.length));
      if (change.newValue) {
        chrome.tabs.get(tabId).then((tab) => applyRulesForTab(tabId, tab.url || "")).catch(() => {});
      } else {
        removeRulesForTab(tabId);
      }
    } else if (key.startsWith(REFRESH_PREFIX)) {
      const sessionId = key.slice(REFRESH_PREFIX.length);
      refreshRulesForSession(sessionId);
    }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "new-session-tab") return;
  const tab = await getActiveTab();
  if (!isSupportedUrl(tab?.url)) return;
  await createSessionForTab(tab, { mode: "new" });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingTabAssignments.delete(tabId);
  removeRulesForTab(tabId);
  chrome.storage.session.remove([tabKey(tabId), ruleKey(tabId)]);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "loading" && changeInfo.status !== "complete") return;
  const targetUrl = tab.url || changeInfo.url || "";
  const assignment = await getTabAssignment(tabId);
  if (!assignment) {
    const pending = pendingTabAssignments.get(tabId);
    if (!pending) return;
    if (isAssignmentUrl(pending, targetUrl)) {
      pendingTabAssignments.delete(tabId);
      await chrome.storage.session.set({ [tabKey(tabId)]: pending });
      await applyRulesForTab(tabId, targetUrl);
      updateBadge(tabId, pending);
    } else if (safeUrl(targetUrl)) {
      pendingTabAssignments.delete(tabId);
      updateBadge(tabId, null);
    }
    return;
  }
  await applyRulesForTab(tabId, targetUrl);
  updateBadgeForUrl(tabId, assignment, targetUrl);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const assignment = await getTabAssignment(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  updateBadgeForUrl(tabId, assignment, tab?.url || "");
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.id || !tab.openerTabId) return;
  const assignment = await getTabAssignment(tab.openerTabId);
  if (!assignment) return;
  const targetUrl = tab.pendingUrl || tab.url || "";
  if (!isAssignmentUrl(assignment, targetUrl)) {
    if (!safeUrl(targetUrl)) pendingTabAssignments.set(tab.id, assignment);
    return;
  }
  await chrome.storage.session.set({ [tabKey(tab.id)]: assignment });
  await applyRulesForTab(tab.id, targetUrl);
  updateBadge(tab.id, assignment);
});

addHeadersReceivedListener();

chrome.webRequest.onCompleted.addListener(
  (details) => {
    syncBrowserCookies(details).catch((error) => console.error(error));
  },
  { urls: ["<all_urls>"], types: RESOURCE_TYPES }
);

function addHeadersReceivedListener() {
  const listener = (details) => {
    captureResponseCookies(details).catch((error) => console.error(error));
  };
  const filter = { urls: ["<all_urls>"], types: RESOURCE_TYPES };
  try {
    chrome.webRequest.onHeadersReceived.addListener(listener, filter, ["responseHeaders", "extraHeaders"]);
  } catch (error) {
    chrome.webRequest.onHeadersReceived.addListener(listener, filter, ["responseHeaders"]);
  }
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case MSG.GET_STATE:
      return getPopupState(message);
    case MSG.CREATE_SESSION:
      return createSessionFromMessage(message);
    case MSG.OPEN_SESSION:
      return openSessionFromMessage(message);
    case MSG.ASSIGN_TAB:
      return assignTabFromMessage(message);
    case MSG.CLEAR_TAB:
      return clearTabFromMessage(message);
    case MSG.CONTENT_SET_COOKIE:
      return setCookieFromContent(message, sender);
    case MSG.CONTENT_DELETE_COOKIE:
      return deleteCookieFromContent(message, sender);
    case MSG.CONTENT_GET_COOKIES:
      return getCookiesFromContent(message, sender);
    default:
      return { ok: false, error: "Unknown message" };
  }
}

async function getPopupState(message) {
  const tab = await resolveTab(message);
  const url = safeUrl(tab?.url);
  const storedAssignment = tab?.id ? await getTabAssignment(tab.id) : null;
  const assignment = isAssignmentUrl(storedAssignment, url?.href) ? storedAssignment : null;
  const sessions = url ? await getSessionsForSite(siteKeyFromUrl(url.href)) : [];
  return {
    ok: true,
    tab: tab ? pickTab(tab) : null,
    supported: Boolean(url),
    siteKey: url ? siteKeyFromUrl(url.href) : "",
    assignment,
    sessions: await addSessionStats(sessions)
  };
}

async function createSessionFromMessage(message) {
  const tab = await resolveTab(message);
  if (!isSupportedUrl(message.url || tab?.url)) return { ok: false, error: "Unsupported tab URL" };
  const session = await createSessionForTab(tab, {
    mode: message.mode || "new",
    name: message.name,
    url: message.url || tab.url
  });
  return { ok: true, session };
}

async function openSessionFromMessage(message) {
  const tab = await resolveTab(message);
  const session = await getSession(message.sessionId);
  if (!tab || !session) return { ok: false, error: "Missing tab or session" };
  const targetUrl = message.url || tab.url;
  if (!isAssignmentUrl(session, targetUrl)) return { ok: false, error: "Session does not match tab URL" };
  const created = await chrome.tabs.create({
    active: true,
    windowId: tab.windowId,
    url: "about:blank"
  });
  await assignTabToSession(created.id, session, targetUrl);
  await chrome.tabs.update(created.id, { url: targetUrl });
  return { ok: true, tabId: created.id };
}

async function assignTabFromMessage(message) {
  const tab = await resolveTab(message);
  const session = await getSession(message.sessionId);
  if (!tab?.id || !session) return { ok: false, error: "Missing tab or session" };
  if (!isAssignmentUrl(session, message.url || tab.url)) return { ok: false, error: "Session does not match tab URL" };
  await assignTabToSession(tab.id, session, message.url || tab.url);
  chrome.tabs.reload(tab.id).catch(() => {});
  setTimeout(() => applyRulesForTab(tab.id, message.url || tab.url).catch(() => {}), 1000);
  return { ok: true };
}

async function clearTabFromMessage(message) {
  const tab = await resolveTab(message);
  if (!tab?.id) return { ok: false, error: "Missing tab" };
  await removeRulesForTab(tab.id);
  await chrome.storage.session.remove([tabKey(tab.id), ruleKey(tab.id)]);
  updateBadge(tab.id, null);
  if (message.reload !== false) chrome.tabs.reload(tab.id).catch(() => {});
  return { ok: true };
}

async function setCookieFromContent(message, sender) {
  const tabId = sender.tab?.id;
  const assignment = tabId ? await getTabAssignment(tabId) : null;
  if (!assignment || !isAssignmentUrl(assignment, message.url || sender.tab?.url)) return { ok: false, error: "Tab has no session" };
  const cookie = parseSetCookie(message.cookie, message.url || sender.tab.url);
  await saveCookie(assignment.sessionId, cookie);
  if (tabId) await refreshTabCookies(tabId, assignment, message.url || sender.tab.url);
  return { ok: true, cookie: publicCookie(cookie) };
}

async function deleteCookieFromContent(message, sender) {
  const tabId = sender.tab?.id;
  const assignment = tabId ? await getTabAssignment(tabId) : null;
  if (!assignment || !isAssignmentUrl(assignment, message.url || sender.tab?.url)) return { ok: false, error: "Tab has no session" };
  const url = safeUrl(message.url || sender.tab.url);
  if (!url) return { ok: false, error: "Bad URL" };
  const domain = normalizeCookieDomain(message.domain || url.hostname);
  const path = message.path || "/";
  await deleteCookie(assignment.sessionId, domain, path, message.name);
  if (tabId) await refreshTabCookies(tabId, assignment, url.href);
  return { ok: true };
}

async function getCookiesFromContent(message, sender) {
  const tabId = sender.tab?.id;
  const assignment = tabId ? await getTabAssignment(tabId) : null;
  if (!assignment || !isAssignmentUrl(assignment, message.url || sender.tab?.url)) return { ok: true, cookies: [] };
  return {
    ok: true,
    cookies: await cookiesForUrl(assignment.sessionId, message.url || sender.tab.url, {
      includeHttpOnly: false
    })
  };
}

async function createSessionForTab(tab, options = {}) {
  const targetUrl = options.url || tab.url;
  const siteKey = siteKeyFromUrl(targetUrl);
  const sessions = await getAllSessions();
  const existingCount = sessions.filter((session) => session.siteKey === siteKey).length;
  const session = {
    id: newId(),
    siteKey,
    name: cleanName(options.name) || `Session ${existingCount + 1}`,
    color: COLORS[existingCount % COLORS.length],
    createdAt: Date.now()
  };
  await chrome.storage.local.set({ [LOCAL_SESSIONS]: [...sessions, session] });
  if (options.mode === "current") {
    await assignTabToSession(tab.id, session, targetUrl);
    chrome.tabs.reload(tab.id).catch(() => {});
    setTimeout(() => applyRulesForTab(tab.id, targetUrl).catch(() => {}), 1000);
  } else {
    const created = await chrome.tabs.create({
      active: true,
      windowId: tab.windowId,
      url: "about:blank"
    });
    await assignTabToSession(created.id, session, targetUrl);
    await chrome.tabs.update(created.id, { url: targetUrl });
  }
  return session;
}

async function assignTabToSession(tabId, session, url) {
  if (!isAssignmentUrl(session, url)) throw new Error("Session does not match tab URL");
  const assignment = {
    sessionId: session.id,
    siteKey: session.siteKey,
    name: session.name,
    color: session.color,
    assignedAt: Date.now()
  };
  await chrome.storage.session.set({ [tabKey(tabId)]: assignment });
  await applyRulesForTab(tabId, url);
  updateBadge(tabId, assignment);
}

async function captureResponseCookies(details) {
  if (details.tabId < 0 || !details.responseHeaders?.length) return;
  const assignment = await getTabAssignment(details.tabId);
  if (!assignment || !isAssignmentUrl(assignment, details.url)) return;
  const setCookieHeaders = details.responseHeaders.filter((header) => {
    return header.name.toLowerCase() === "set-cookie" && header.value;
  });
  if (!setCookieHeaders.length) return;
  for (const header of setCookieHeaders) {
    const cookie = parseSetCookie(header.value, details.url);
    await saveCookie(assignment.sessionId, cookie);
    await removeBrowserCookie(details.url, cookie).catch(() => {});
  }
  await refreshTabCookies(details.tabId, assignment, details.url);
}

async function removeBrowserCookie(sourceUrl, cookie) {
  const url = new URL(sourceUrl);
  url.pathname = cookie.path || "/";
  url.search = "";
  url.hash = "";
  await chrome.cookies.remove({ url: url.href, name: cookie.name });
}

async function refreshTabCookies(tabId, assignment, url) {
  await applyRulesForTab(tabId, url);
  if (!isAssignmentUrl(assignment, url)) return;
  const cookies = await cookiesForUrl(assignment.sessionId, url, { includeHttpOnly: false });
  chrome.tabs.sendMessage(tabId, { type: "content:cookiesUpdated", cookies }).catch(() => {});
}

async function syncBrowserCookies(details) {
  if (details.tabId < 0) return;
  const assignment = await getTabAssignment(details.tabId);
  if (!assignment || !isAssignmentUrl(assignment, details.url)) return;
  const browserCookies = await chrome.cookies.getAll({ url: details.url });
  if (!browserCookies.length) return;
  for (const browserCookie of browserCookies) {
    const cookie = cookieFromChrome(browserCookie);
    await saveCookie(assignment.sessionId, cookie);
    await removeBrowserCookie(details.url, cookie).catch(() => {});
  }
  await refreshTabCookies(details.tabId, assignment, details.url);
}

function cookieFromChrome(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: normalizeCookieDomain(cookie.domain),
    hostOnly: cookie.hostOnly,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite || "unspecified",
    expiresAt: cookie.expirationDate ? cookie.expirationDate * 1000 : null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

async function applyRulesForTab(tabId, url) {
  const previous = tabRuleQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => applyRulesForTabNow(tabId, url));
  tabRuleQueues.set(tabId, next);
  try {
    await next;
  } finally {
    if (tabRuleQueues.get(tabId) === next) tabRuleQueues.delete(tabId);
  }
}

async function applyRulesForTabNow(tabId, url) {
  await removeRulesForTab(tabId);
  const assignment = await getTabAssignment(tabId);
  if (!assignment) return;
  const currentUrl = safeUrl(url);
  if (!currentUrl || !isAssignmentUrl(assignment, currentUrl.href)) {
    updateBadge(tabId, null);
    return;
  }
  const rules = [];
  const stripRuleId = ruleId(tabId, "strip");
  rules.push({
    id: stripRuleId,
    priority: 1000,
    condition: { tabIds: [tabId], resourceTypes: RESOURCE_TYPES, regexFilter: exactHostRegex(assignment.siteKey) },
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Cookie", operation: "remove" }]
    }
  });

  const cookies = await getSessionCookies(assignment.sessionId);
  const liveCookies = Object.values(cookies).filter((cookie) => !isExpired(cookie));
  const header = cookieHeaderForUrl(liveCookies, currentUrl.href);
  if (header) rules.push(cookieRule(tabId, `exact:${assignment.siteKey}`, 3000, exactHostRegex(assignment.siteKey), header));

  await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
  await chrome.storage.session.set({ [ruleKey(tabId)]: rules.map((item) => item.id) });
  await injectPageContext(tabId, assignment.sessionId, url);
}

async function refreshRulesForSession(sessionId) {
  const stored = await chrome.storage.session.get(null);
  for (const [key, assignment] of Object.entries(stored)) {
    if (!key.startsWith(TAB_PREFIX) || assignment?.sessionId !== sessionId) continue;
    const tabId = Number(key.slice(TAB_PREFIX.length));
    chrome.tabs.get(tabId).then((tab) => applyRulesForTab(tabId, tab.url || "")).catch(() => {});
  }
}

async function injectPageContext(tabId, sessionId, url) {
  const session = await getSession(sessionId);
  if (!session || !isAssignmentUrl(session, url)) return;
  const context = {
    session,
    prefix: `mst:${session.id}:`,
    cookies: await cookiesForUrl(session.id, url, { includeHttpOnly: false })
  };
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    injectImmediately: true,
    func: installPageContext,
    args: [context]
  }).catch(() => {});
}

function installPageContext(context) {
  if (window.__MULTISESSION_TABS_BOOTED__) return;
  window.__MULTISESSION_TABS_BOOTED__ = true;

  const PAGE_SOURCE = "multisession-tabs:page";
  const EXT_SOURCE = "multisession-tabs:extension";
  let visibleCookies = context.cookies || [];
  let requestId = 0;
  const pending = new Map();
  const prefix = context.prefix;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== EXT_SOURCE) return;
    if (event.data.type === "cookiesUpdated") {
      visibleCookies = event.data.cookies || [];
      return;
    }
    if (event.data.type === "response" && pending.has(event.data.id)) {
      pending.get(event.data.id)(event.data.response || { ok: false, error: event.data.error });
      pending.delete(event.data.id);
    }
  });

  patchDocumentCookie();
  patchCookieStore();
  patchStorage("localStorage");
  patchStorage("sessionStorage");
  patchIndexedDB();
  patchCaches();
  patchBroadcastChannel();
  patchWorkers();
  patchServiceWorker();
  addSessionMarker();

  function patchDocumentCookie() {
    const descriptor = {
      configurable: true,
      enumerable: true,
      get() {
        return visibleCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      },
      set(value) {
        const parsed = parseCookieAssignment(value);
        if (parsed) upsertVisibleCookie(parsed);
        sendToExtension({ type: "setCookie", cookie: String(value) }).then((response) => {
          if (response?.cookie) upsertVisibleCookie(response.cookie);
        });
      }
    };
    Object.defineProperty(document, "cookie", descriptor);
    Object.defineProperty(Document.prototype, "cookie", descriptor);
  }

  function patchCookieStore() {
    if (!("cookieStore" in window)) return;
    const store = {
      async get(nameOrOptions) {
        const name = typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions?.name;
        return visibleCookies.find((cookie) => cookie.name === name) || null;
      },
      async getAll(options = {}) {
        if (!options.name) return [...visibleCookies];
        return visibleCookies.filter((cookie) => cookie.name === options.name);
      },
      async set(nameOrOptions, value) {
        const options = typeof nameOrOptions === "string" ? { name: nameOrOptions, value } : nameOrOptions;
        const response = await sendToExtension({ type: "setCookie", cookie: serializeCookieStoreSet(options) });
        if (response?.cookie) upsertVisibleCookie(response.cookie);
      },
      async delete(nameOrOptions) {
        const options = typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions;
        await sendToExtension({ type: "deleteCookie", name: options.name, domain: options.domain, path: options.path || "/" });
        visibleCookies = visibleCookies.filter((cookie) => cookie.name !== options.name);
      },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      }
    };
    Object.defineProperty(window, "cookieStore", { value: store, configurable: true });
  }

  function patchStorage(property) {
    const nativeStorage = window[property];
    if (!nativeStorage) return;
    const scopedPrefix = `${prefix}${property}:`;
    const keys = () => {
      const out = [];
      for (let index = 0; index < nativeStorage.length; index += 1) {
        const key = nativeStorage.key(index);
        if (key?.startsWith(scopedPrefix)) out.push(key);
      }
      return out.sort();
    };
    const target = {
      get length() {
        return keys().length;
      },
      key(index) {
        return keys()[index]?.slice(scopedPrefix.length) || null;
      },
      getItem(key) {
        return nativeStorage.getItem(scopedPrefix + String(key));
      },
      setItem(key, value) {
        nativeStorage.setItem(scopedPrefix + String(key), String(value));
      },
      removeItem(key) {
        nativeStorage.removeItem(scopedPrefix + String(key));
      },
      clear() {
        for (const key of keys()) nativeStorage.removeItem(key);
      }
    };
    const proxy = new Proxy(target, {
      get(object, prop) {
        if (prop in object) {
          const value = object[prop];
          return typeof value === "function" ? value.bind(object) : value;
        }
        if (typeof prop === "string") return object.getItem(prop);
        return undefined;
      },
      set(object, prop, value) {
        if (typeof prop === "string") {
          object.setItem(prop, value);
          return true;
        }
        object[prop] = value;
        return true;
      },
      deleteProperty(object, prop) {
        if (typeof prop === "string") {
          object.removeItem(prop);
          return true;
        }
        return false;
      },
      ownKeys() {
        return keys().map((key) => key.slice(scopedPrefix.length));
      },
      getOwnPropertyDescriptor(object, prop) {
        if (typeof prop !== "string") return undefined;
        const value = object.getItem(prop);
        if (value === null) return undefined;
        return { configurable: true, enumerable: true, value };
      }
    });
    Object.defineProperty(window, property, { value: proxy, configurable: true, writable: true });
  }

  function patchIndexedDB() {
    if (!window.indexedDB) return;
    const native = window.indexedDB;
    const scopedPrefix = `${prefix}idb:`;
    const patched = {
      open(name, version) {
        return native.open(scopedPrefix + String(name), version);
      },
      deleteDatabase(name) {
        return native.deleteDatabase(scopedPrefix + String(name));
      },
      cmp(first, second) {
        return native.cmp(first, second);
      }
    };
    if (typeof native.databases === "function") {
      patched.databases = async () => {
        const databases = await native.databases();
        return databases
          .filter((database) => database.name?.startsWith(scopedPrefix))
          .map((database) => ({ ...database, name: database.name.slice(scopedPrefix.length) }));
      };
    }
    Object.defineProperty(window, "indexedDB", { value: patched, configurable: true, writable: true });
  }

  function patchCaches() {
    if (!window.caches) return;
    const native = window.caches;
    const scopedPrefix = `${prefix}cache:`;
    const patched = {
      open(name) {
        return native.open(scopedPrefix + String(name));
      },
      async keys() {
        return (await native.keys())
          .filter((key) => key.startsWith(scopedPrefix))
          .map((key) => key.slice(scopedPrefix.length));
      },
      delete(name) {
        return native.delete(scopedPrefix + String(name));
      },
      has(name) {
        return native.has(scopedPrefix + String(name));
      },
      async match(request, options) {
        for (const name of await patched.keys()) {
          const response = await (await patched.open(name)).match(request, options);
          if (response) return response;
        }
        return undefined;
      }
    };
    Object.defineProperty(window, "caches", { value: patched, configurable: true, writable: true });
  }

  function patchBroadcastChannel() {
    if (!window.BroadcastChannel) return;
    const NativeBroadcastChannel = window.BroadcastChannel;
    class ScopedBroadcastChannel extends NativeBroadcastChannel {
      constructor(name) {
        super(`${prefix}bc:${name}`);
      }
    }
    Object.defineProperty(window, "BroadcastChannel", { value: ScopedBroadcastChannel, configurable: true, writable: true });
  }

  function patchWorkers() {
    patchWorkerClass("Worker");
    patchWorkerClass("SharedWorker");
  }

  function patchWorkerClass(property) {
    const NativeWorker = window[property];
    if (!NativeWorker) return;
    window[property] = class ScopedWorker extends NativeWorker {
      constructor(scriptUrl, options) {
        super(scopedWorkerUrl(scriptUrl), options);
      }
    };
  }

  function patchServiceWorker() {
    if (!navigator.serviceWorker?.register) return;
    const nativeRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      writable: true,
      value(scriptUrl, options) {
        return nativeRegister(scopedWorkerUrl(scriptUrl), options).catch(() => nativeRegister(scriptUrl, options));
      }
    });
  }

  function scopedWorkerUrl(scriptUrl) {
    try {
      const absoluteUrl = new URL(scriptUrl, location.href).href;
      const request = new XMLHttpRequest();
      request.open("GET", absoluteUrl, false);
      request.send(null);
      if (request.status < 200 || request.status >= 300) return scriptUrl;
      return URL.createObjectURL(new Blob([workerPrelude(), "\n", request.responseText], { type: "application/javascript" }));
    } catch {
      return scriptUrl;
    }
  }

  function workerPrelude() {
    return `
      (() => {
        const prefix = ${JSON.stringify(prefix)};
        if (self.indexedDB) {
          const native = self.indexedDB;
          const scoped = prefix + "idb:";
          Object.defineProperty(self, "indexedDB", { configurable: true, value: {
            open: (name, version) => native.open(scoped + String(name), version),
            deleteDatabase: (name) => native.deleteDatabase(scoped + String(name)),
            cmp: (a, b) => native.cmp(a, b),
            databases: native.databases ? async () => (await native.databases()).filter((db) => db.name && db.name.startsWith(scoped)).map((db) => ({...db, name: db.name.slice(scoped.length)})) : undefined
          }});
        }
        if (self.caches) {
          const native = self.caches;
          const scoped = prefix + "cache:";
          Object.defineProperty(self, "caches", { configurable: true, value: {
            open: (name) => native.open(scoped + String(name)),
            keys: async () => (await native.keys()).filter((key) => key.startsWith(scoped)).map((key) => key.slice(scoped.length)),
            delete: (name) => native.delete(scoped + String(name)),
            has: (name) => native.has(scoped + String(name)),
            match: async (request, options) => {
              const names = (await native.keys()).filter((key) => key.startsWith(scoped));
              for (const fullName of names) {
                const response = await (await native.open(fullName)).match(request, options);
                if (response) return response;
              }
              return undefined;
            }
          }});
        }
        if (self.BroadcastChannel) {
          const NativeBroadcastChannel = self.BroadcastChannel;
          self.BroadcastChannel = class ScopedBroadcastChannel extends NativeBroadcastChannel {
            constructor(name) { super(prefix + "bc:" + name); }
          };
        }
      })();
    `;
  }

  function addSessionMarker() {
    document.documentElement.dataset.multisessionTabs = context.session.id;
    const marker = document.createElement("style");
    marker.textContent = `html::before{content:"";position:fixed;z-index:2147483647;left:0;right:0;top:0;height:4px;background:${context.session.color};pointer-events:none}`;
    document.documentElement.appendChild(marker);
  }

  function parseCookieAssignment(value) {
    const [pair] = String(value).split(";");
    const eq = pair.indexOf("=");
    if (eq < 1) return null;
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1), path: "/" };
  }

  function serializeCookieStoreSet(options) {
    const parts = [`${options.name}=${options.value ?? ""}`];
    if (options.domain) parts.push(`Domain=${options.domain}`);
    parts.push(`Path=${options.path || "/"}`);
    if (options.expires) parts.push(`Expires=${new Date(options.expires).toUTCString()}`);
    if (options.secure) parts.push("Secure");
    if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
    return parts.join("; ");
  }

  function upsertVisibleCookie(cookie) {
    visibleCookies = visibleCookies.filter((item) => {
      return !(item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path);
    });
    if (!cookie.expiresAt || cookie.expiresAt > Date.now()) visibleCookies.push(cookie);
  }

  function sendToExtension(message) {
    const id = `${Date.now()}:${requestId += 1}`;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      window.postMessage({ source: PAGE_SOURCE, id, sessionId: context.session.id, ...message }, "*");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ ok: false, error: "Bridge timeout" });
        }
      }, 5000);
    });
  }
}

function cookieRule(tabId, seed, priority, regexFilter, cookieHeader) {
  return {
    id: ruleId(tabId, seed),
    priority,
    condition: { tabIds: [tabId], resourceTypes: RESOURCE_TYPES, regexFilter },
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Cookie", operation: "set", value: cookieHeader }]
    }
  };
}

async function removeRulesForTab(tabId) {
  const stored = await chrome.storage.session.get(ruleKey(tabId));
  const ruleIds = stored[ruleKey(tabId)] || [];
  if (ruleIds.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
  }
  await chrome.storage.session.remove(ruleKey(tabId));
}

async function getSessionCookies(sessionId) {
  const stored = await chrome.storage.local.get(LOCAL_COOKIES);
  return stored[LOCAL_COOKIES]?.[sessionId] || {};
}

async function saveCookie(sessionId, cookie) {
  const stored = await chrome.storage.local.get(LOCAL_COOKIES);
  const all = stored[LOCAL_COOKIES] || {};
  const sessionCookies = { ...(all[sessionId] || {}) };
  const key = cookieKey(cookie.domain, cookie.path, cookie.name);
  if (isDeletion(cookie)) delete sessionCookies[key];
  else sessionCookies[key] = cookie;
  await chrome.storage.local.set({ [LOCAL_COOKIES]: { ...all, [sessionId]: sessionCookies } });
}

async function deleteCookie(sessionId, domain, path, name) {
  const stored = await chrome.storage.local.get(LOCAL_COOKIES);
  const all = stored[LOCAL_COOKIES] || {};
  const sessionCookies = { ...(all[sessionId] || {}) };
  delete sessionCookies[cookieKey(domain, path, name)];
  await chrome.storage.local.set({ [LOCAL_COOKIES]: { ...all, [sessionId]: sessionCookies } });
}

async function cookiesForUrl(sessionId, url, options = {}) {
  const parsed = safeUrl(url);
  if (!parsed) return [];
  const cookies = Object.values(await getSessionCookies(sessionId)).filter((cookie) => {
    if (!options.includeHttpOnly && cookie.httpOnly) return false;
    return cookieMatchesUrl(cookie, parsed);
  });
  return cookies.map(publicCookie);
}

function cookieHeaderForUrl(cookies, url) {
  const parsed = safeUrl(url);
  if (!parsed) return "";
  return cookies
    .filter((cookie) => cookieMatchesUrl(cookie, parsed))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function cookieMatchesUrl(cookie, url) {
  return !isExpired(cookie) &&
    (!cookie.secure || url.protocol === "https:") &&
    domainMatches(url.hostname.toLowerCase(), cookie.domain, cookie.hostOnly) &&
    pathMatches(url.pathname || "/", cookie.path || "/");
}

function parseSetCookie(header, sourceUrl) {
  const url = safeUrl(sourceUrl);
  if (!url) throw new Error("Bad cookie source URL");
  const parts = splitCookieParts(header);
  const [namePart, ...attributes] = parts;
  const eq = namePart.indexOf("=");
  if (eq < 1) throw new Error("Bad Set-Cookie header");
  const cookie = {
    name: namePart.slice(0, eq).trim(),
    value: namePart.slice(eq + 1),
    domain: url.hostname.toLowerCase(),
    hostOnly: true,
    path: defaultCookiePath(url.pathname),
    secure: false,
    httpOnly: false,
    sameSite: "unspecified",
    expiresAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  for (const attr of attributes) {
    const attrEq = attr.indexOf("=");
    const rawName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
    const rawValue = attrEq === -1 ? "" : attr.slice(attrEq + 1).trim();
    if (rawName === "domain" && rawValue) {
      const domain = normalizeCookieDomain(rawValue);
      if (domainMatches(url.hostname.toLowerCase(), domain, false)) {
        cookie.domain = domain;
        cookie.hostOnly = false;
      }
    } else if (rawName === "path" && rawValue.startsWith("/")) {
      cookie.path = rawValue;
    } else if (rawName === "secure") {
      cookie.secure = true;
    } else if (rawName === "httponly") {
      cookie.httpOnly = true;
    } else if (rawName === "samesite") {
      cookie.sameSite = rawValue.toLowerCase();
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

function splitCookieParts(header) {
  const parts = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (char === ";") {
      parts.push(header.slice(start, index).trim());
      start = index + 1;
      inExpires = false;
    } else if (!inExpires && header.slice(index, index + 8).toLowerCase() === "expires=") {
      inExpires = true;
    }
  }
  parts.push(header.slice(start).trim());
  return parts.filter(Boolean);
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

async function addSessionStats(sessions) {
  const stored = await chrome.storage.local.get(LOCAL_COOKIES);
  const all = stored[LOCAL_COOKIES] || {};
  return sessions.map((session) => ({
    ...session,
    cookieCount: Object.values(all[session.id] || {}).filter((cookie) => !isExpired(cookie)).length
  }));
}

async function getAllSessions() {
  const stored = await chrome.storage.local.get(LOCAL_SESSIONS);
  return stored[LOCAL_SESSIONS] || [];
}

async function getSessionsForSite(siteKey) {
  return (await getAllSessions()).filter((session) => session.siteKey === siteKey);
}

async function getSession(sessionId) {
  return (await getAllSessions()).find((session) => session.id === sessionId);
}

async function getTabAssignment(tabId) {
  const stored = await chrome.storage.session.get(tabKey(tabId));
  return stored[tabKey(tabId)] || null;
}

async function resolveTab(message) {
  if (message?.tabId) return chrome.tabs.get(message.tabId);
  return getActiveTab();
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
  return tabs[0] || null;
}

function updateBadge(tabId, assignment) {
  if (!tabId) return;
  if (!assignment) {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    return;
  }
  chrome.action.setBadgeText({ tabId, text: " " }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: assignment.color }).catch(() => {});
  chrome.action.setTitle({ tabId, title: `MultiSession: ${assignment.name}` }).catch(() => {});
}

function updateBadgeForUrl(tabId, assignment, url) {
  updateBadge(tabId, isAssignmentUrl(assignment, url) ? assignment : null);
}

function pickTab(tab) {
  return { id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId };
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSupportedUrl(value) {
  return Boolean(safeUrl(value));
}

function isAssignmentUrl(assignment, value) {
  const url = safeUrl(value);
  return Boolean(assignment?.siteKey && url && url.hostname.toLowerCase() === assignment.siteKey);
}

function siteKeyFromUrl(value) {
  const url = safeUrl(value);
  if (!url) throw new Error("Unsupported URL");
  return url.hostname.toLowerCase();
}

function cleanName(value) {
  return String(value || "").trim().slice(0, 40);
}

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function tabKey(tabId) {
  return `${TAB_PREFIX}${tabId}`;
}

function ruleKey(tabId) {
  return `${RULE_PREFIX}${tabId}`;
}

function cookieKey(domain, path, name) {
  return `${domain};${path};${name}`;
}

function isExpired(cookie) {
  return cookie.expiresAt !== null && cookie.expiresAt <= Date.now();
}

function isDeletion(cookie) {
  return cookie.expiresAt !== null && cookie.expiresAt <= Date.now();
}

function normalizeCookieDomain(domain) {
  return domain.trim().replace(/^\./, "").toLowerCase();
}

function domainMatches(host, cookieDomain, hostOnly) {
  const normalizedHost = host.toLowerCase();
  const normalizedDomain = normalizeCookieDomain(cookieDomain);
  if (hostOnly) return normalizedHost === normalizedDomain;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function pathMatches(requestPath, cookiePath) {
  const path = cookiePath || "/";
  return requestPath === path || requestPath.startsWith(path.endsWith("/") ? path : `${path}/`) || path === "/";
}

function defaultCookiePath(pathname) {
  if (!pathname || pathname[0] !== "/") return "/";
  if (pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function exactHostRegex(host) {
  return `^https?://${escapeRegex(host)}(?::[0-9]+)?(?:/|$)`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ruleId(tabId, seed) {
  let hash = 2166136261;
  const input = `${tabId}:${seed}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147480000;
}
