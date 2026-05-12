"use strict";

const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const childProcess = require("child_process");
const puppeteer = require("puppeteer-core");

const root = path.resolve(__dirname, "..");

if (!process.env.DISPLAY && !process.env.MST_UNDER_XVFB) {
  const result = childProcess.spawnSync("xvfb-run", ["-a", process.execPath, __filename], {
    cwd: root,
    env: { ...process.env, MST_UNDER_XVFB: "1" },
    stdio: "inherit"
  });
  process.exit(result.status ?? 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const server = await startServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mst-chrome-"));
  const browser = await puppeteer.launch({
    executablePath: findChromeExecutable(),
    headless: false,
    userDataDir,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage"
    ]
  });

  try {
    console.log("browser ready");
    const { extensionId, workerSession } = await getExtensionContext(browser);
    console.log(`extension ${extensionId}`);
    const extPage = await browser.newPage();
    await extPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await assertPopupResponds(extPage);

    const pageA = await browser.newPage();
    await pageA.goto(`${server.origin}/app.html`);
    const tabA = await findTabId(extPage, `${server.origin}/*`);
    console.log(`tab A ${tabA}`);
    await backgroundMessage(workerSession, { type: "session:create", tabId: tabA, url: pageA.url(), mode: "current", name: "A" });
    await pageA.reload({ waitUntil: "domcontentloaded" });
    await waitForSessionMarker(pageA, workerSession, tabA, "A");

    await setPageState(pageA, "A");
    await refreshTabRules(workerSession, tabA, pageA.url());
    await waitForCookieHeader(pageA, "sid=A", "A");
    const stateA = await readPageState(pageA);
    assert(stateA.cookie.includes("sid=A"), "A document.cookie missing");
    assert(stateA.local === "A", "A localStorage missing");
    assert(stateA.session === "A", "A sessionStorage missing");
    assert(stateA.idb === "A", "A IndexedDB missing");
    assert(stateA.cache === "A", "A CacheStorage missing");
    assert(stateA.worker === "A", "A Worker storage missing");
    assert(stateA.echo.cookie.includes("sid=A"), "A request Cookie header missing");
    await assertOpenedLinksStayScoped(browser, extPage, workerSession, pageA, tabA, server);

    const pageB = await browser.newPage();
    await pageB.goto(`${server.origin}/app.html`);
    const tabs = await tabsForUrl(extPage, `${server.origin}/*`);
    const tabB = tabs.find((tab) => tab.id !== tabA).id;
    console.log(`tab B ${tabB}`);
    await backgroundMessage(workerSession, { type: "session:create", tabId: tabB, url: pageB.url(), mode: "current", name: "B" });
    await pageB.reload({ waitUntil: "domcontentloaded" });
    await waitForSessionMarker(pageB, workerSession, tabB, "B");

    await setPageState(pageB, "B");
    await refreshTabRules(workerSession, tabB, pageB.url());
    await waitForCookieHeader(pageB, "sid=B", "B");
    const stateB = await readPageState(pageB);
    assert(stateB.cookie.includes("sid=B"), "B document.cookie missing");
    assert(!stateB.cookie.includes("sid=A"), "B sees A cookie");
    assert(stateB.local === "B", "B localStorage missing");
    assert(stateB.session === "B", "B sessionStorage missing");
    assert(stateB.idb === "B", "B IndexedDB missing");
    assert(stateB.cache === "B", "B CacheStorage missing");
    assert(stateB.worker === "B", "B Worker storage missing");
    assert(stateB.echo.cookie.includes("sid=B"), "B request Cookie header missing");
    assert(!stateB.echo.cookie.includes("sid=A"), "B request leaks A cookie");
    await assertBroadcastIsolated(pageA, pageB);

    await pageA.reload({ waitUntil: "domcontentloaded" });
    await refreshTabRules(workerSession, tabA, pageA.url());
    await waitForSessionMarker(pageA, workerSession, tabA, "A after reload");
    const stateAAfter = await readPageState(pageA);
    assert(stateAAfter.cookie.includes("sid=A"), "A cookie not persisted after reload");
    assert(!stateAAfter.cookie.includes("sid=B"), "A sees B cookie");
    assert(stateAAfter.local === "A", "A localStorage not isolated after reload");
    assert(stateAAfter.session === "A", "A sessionStorage not isolated after reload");
    assert(stateAAfter.idb === "A", "A IndexedDB not isolated after reload");
    assert(stateAAfter.cache === "A", "A CacheStorage not isolated after reload");
    assert(stateAAfter.worker === "A", "A Worker storage not isolated after reload");

    const normal = await browser.newPage();
    await normal.goto(`${server.origin}/app.html`);
    const normalState = await readPageState(normal);
    assert(!normalState.cookie.includes("sid=A") && !normalState.cookie.includes("sid=B"), "normal tab sees session cookies");
    assert(normalState.local === null, "normal tab sees session localStorage");

    console.log("e2e ok");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.instance.close(resolve));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

function findChromeExecutable() {
  if (process.env.CHROME_EXECUTABLE) return process.env.CHROME_EXECUTABLE;
  const projectBrowserRoot = path.join(root, ".browsers", "chrome");
  if (fs.existsSync(projectBrowserRoot)) {
    const candidates = [];
    for (const version of fs.readdirSync(projectBrowserRoot)) {
      candidates.push(path.join(projectBrowserRoot, version, "chrome-linux64", "chrome"));
    }
    const match = candidates.find((candidate) => fs.existsSync(candidate));
    if (match) return match;
  }
  for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome executable not found");
}

async function getExtensionContext(browser) {
  const target = await browser.waitForTarget((item) => {
    return item.type() === "service_worker" && item.url().startsWith("chrome-extension://");
  }, { timeout: 10000 });
  const workerSession = await target.createCDPSession();
  await workerSession.send("Runtime.enable");
  workerSession.on("Runtime.consoleAPICalled", (event) => {
    console.log(`[sw] ${event.type}: ${event.args.map((arg) => arg.value || arg.description).join(" ")}`);
  });
  return { extensionId: new URL(target.url()).host, workerSession };
}

async function assertPopupResponds(page) {
  await page.waitForFunction(() => {
    return document.getElementById("site")?.textContent !== "Loading...";
  }, { timeout: 5000 });
  const text = await page.$eval("#site", (node) => node.textContent);
  assert(text !== "Extension background did not respond", text);
}

async function backgroundMessage(workerSession, message) {
  const expression = `handleMessage(${JSON.stringify(message)}, {}).then((value) => JSON.stringify(value)).catch((error) => JSON.stringify({ ok: false, error: error.message || String(error) }))`;
  const result = await workerSession.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  const response = JSON.parse(result.result.value);
  assert(response?.ok, response?.error || "background message failed");
  return response;
}

async function refreshTabRules(workerSession, tabId, url) {
  const expression = `applyRulesForTab(${tabId}, ${JSON.stringify(url)}).then(() => 'ok').catch((error) => 'ERR:' + (error.message || String(error)))`;
  const result = await workerSession.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  assert(result.result.value === "ok", result.result.value);
}

async function waitForSessionMarker(page, workerSession, tabId, label) {
  try {
    await page.waitForFunction(() => document.documentElement.dataset.multisessionTabs, { timeout: 5000 });
  } catch (error) {
    const state = await backgroundMessage(workerSession, { type: "popup:getState", tabId });
    const pageState = await page.evaluate(() => ({
      readyState: document.readyState,
      marker: document.documentElement.dataset.multisessionTabs || null,
      booted: Boolean(window.__MULTISESSION_TABS_BOOTED__)
    }));
    const receiver = await workerEval(workerSession, `
      chrome.tabs.sendMessage(${tabId}, { type: "content:cookiesUpdated", cookies: [] })
        .then(() => "ok")
        .catch((error) => "ERR:" + (error.message || String(error)))
    `);
    throw new Error(`${label} session marker missing; state=${JSON.stringify(state)} page=${JSON.stringify(pageState)} receiver=${receiver}`);
  }
}

async function assertOpenedLinksStayScoped(browser, extPage, workerSession, page, sourceTabId, server) {
  const externalOrigin = `http://localhost:${new URL(server.origin).port}`;

  const sameSitePage = await clickNewPage(browser, page, "#same-site-link");
  const sameSiteTabId = (await tabsForUrl(extPage, `${server.origin}/*`)).find((tab) => tab.id !== sourceTabId).id;
  await waitForSessionMarker(sameSitePage, workerSession, sameSiteTabId, "same-site opened tab");

  await sameSitePage.goto(`${externalOrigin}/app.html`, { waitUntil: "domcontentloaded" });
  await assertNoSessionOnPage(workerSession, sameSiteTabId, sameSitePage, "external navigation in assigned tab");
  await sameSitePage.close();

  const externalPage = await clickNewPage(browser, page, "#external-link");
  const externalTabs = await tabsForUrl(extPage, `${externalOrigin}/*`);
  const externalTabId = externalTabs.find((tab) => tab.id !== sourceTabId).id;
  await assertNoSessionOnPage(workerSession, externalTabId, externalPage, "external opened tab");
  const storedAssignment = JSON.parse(await workerEval(workerSession, `getTabAssignment(${externalTabId}).then((value) => JSON.stringify(value))`));
  assert(storedAssignment === null, "external opened tab inherited session assignment");
  await externalPage.close();
}

async function clickNewPage(browser, page, selector) {
  const existingTargets = new Set(browser.targets());
  await page.bringToFront();
  await page.click(selector);
  const target = await browser.waitForTarget((item) => {
    return item.type() === "page" && !existingTargets.has(item);
  }, { timeout: 5000 });
  const newPage = await target.page();
  await newPage.waitForFunction(() => document.readyState !== "loading", { timeout: 5000 });
  return newPage;
}

async function assertNoSessionOnPage(workerSession, tabId, page, label) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const state = await page.evaluate(async () => {
    const response = await fetch("/echo");
    return {
      marker: document.documentElement.dataset.multisessionTabs || null,
      booted: Boolean(window.__MULTISESSION_TABS_BOOTED__),
      cookie: document.cookie,
      echo: await response.json()
    };
  });
  const popupState = await backgroundMessage(workerSession, { type: "popup:getState", tabId });
  assert(!state.marker, `${label} has session marker`);
  assert(!state.booted, `${label} booted session patch`);
  assert(!state.cookie.includes("sid=A"), `${label} sees session document.cookie`);
  assert(!state.echo.cookie.includes("sid=A"), `${label} sends session Cookie header`);
  assert(!popupState.assignment, `${label} popup reports active assignment`);
}

async function workerEval(workerSession, expression) {
  const result = await workerSession.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  return result.result.value;
}

async function findTabId(page, urlPattern) {
  const tabs = await tabsForUrl(page, urlPattern);
  assert(tabs.length > 0, `No tab for ${urlPattern}`);
  return tabs[0].id;
}

async function tabsForUrl(page, urlPattern) {
  return page.evaluate((pattern) => chrome.tabs.query({ url: pattern }), urlPattern);
}

async function setPageState(page, value) {
  await page.evaluate(async (next) => {
    document.cookie = `sid=${next}; path=/`;
    localStorage.setItem("user", next);
    sessionStorage.setItem("user", next);
    await Promise.race([
      idbSet("user", next),
      new Promise((_, reject) => setTimeout(() => reject(new Error("idbSet timeout")), 3000))
    ]);
    const cache = await caches.open("state");
    await cache.put("/cache-data", new Response(next));
    await workerRoundTrip("set", next);
  }, value);
}

async function readPageState(page) {
  return page.evaluate(async () => {
    const cached = await caches.match("/cache-data");
    return {
      cookie: document.cookie,
      local: localStorage.getItem("user"),
      session: sessionStorage.getItem("user"),
      idb: await idbGet("user"),
      cache: cached ? await cached.text() : null,
      worker: await workerRoundTrip("get"),
      echo: await fetch("/echo").then((response) => response.json())
    };
  });
}

async function assertBroadcastIsolated(pageA, pageB) {
  await pageA.evaluate(() => {
    window.__mstBroadcastMessages = [];
    window.__mstBroadcastChannel = new BroadcastChannel("shared");
    window.__mstBroadcastChannel.onmessage = (event) => {
      window.__mstBroadcastMessages.push(event.data);
    };
  });
  await pageB.evaluate(() => {
    const channel = new BroadcastChannel("shared");
    channel.postMessage("from-b");
    channel.close();
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const messages = await pageA.evaluate(() => {
    window.__mstBroadcastChannel.close();
    return window.__mstBroadcastMessages;
  });
  assert(!messages.includes("from-b"), "BroadcastChannel crossed sessions");
}

async function waitForCookieHeader(page, expected, label) {
  try {
    await page.waitForFunction(async (cookie) => {
      const response = await fetch("/echo");
      const body = await response.json();
      return body.cookie.includes(cookie);
    }, { timeout: 10000 }, expected);
  } catch (error) {
    const state = await page.evaluate(async () => {
      const response = await fetch("/echo");
      return {
        documentCookie: document.cookie,
        local: localStorage.getItem("user"),
        marker: document.documentElement.dataset.multisessionTabs || null,
        echo: await response.json()
      };
    });
    throw new Error(`${label} never sent ${expected}; state=${JSON.stringify(state)}`);
  }
}

function startServer() {
  const instance = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/app.html") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <html>
          <head><title>Test app</title></head>
          <body>
            <a id="same-site-link" href="/app.html" target="_blank">same site</a>
            <a id="external-link" href="http://localhost:${request.headers.host.split(":").pop()}/app.html" target="_blank">external site</a>
            <script>
              function workerRoundTrip(command, value) {
                return new Promise((resolve, reject) => {
                  const worker = new Worker("/worker.js");
                  const timeout = setTimeout(() => {
                    worker.terminate();
                    reject(new Error("worker timeout"));
                  }, 3000);
                  worker.onmessage = (event) => {
                    clearTimeout(timeout);
                    worker.terminate();
                    if (event.data && event.data.error) reject(new Error(event.data.error));
                    else resolve(event.data ? event.data.value : null);
                  };
                  worker.onerror = (event) => {
                    clearTimeout(timeout);
                    worker.terminate();
                    reject(new Error(event.message || "worker error"));
                  };
                  worker.postMessage({ command, value });
                });
              }
              function idbSet(key, value) {
                return new Promise((resolve, reject) => {
                  const open = indexedDB.open("state", 1);
                  open.onupgradeneeded = () => open.result.createObjectStore("kv");
                  open.onerror = () => reject(open.error);
                  open.onsuccess = () => {
                    const tx = open.result.transaction("kv", "readwrite");
                    tx.objectStore("kv").put(value, key);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                  };
                });
              }
              function idbGet(key) {
                return new Promise((resolve, reject) => {
                  const open = indexedDB.open("state", 1);
                  open.onupgradeneeded = () => open.result.createObjectStore("kv");
                  open.onerror = () => reject(open.error);
                  open.onsuccess = () => {
                    const tx = open.result.transaction("kv", "readonly");
                    const get = tx.objectStore("kv").get(key);
                    get.onsuccess = () => resolve(get.result ?? null);
                    get.onerror = () => reject(get.error);
                  };
                });
              }
            </script>
          </body>
        </html>`);
      return;
    }
    if (url.pathname === "/worker.js") {
      response.setHeader("content-type", "application/javascript; charset=utf-8");
      response.end(`
        self.onmessage = async (event) => {
          try {
            if (event.data.command === "set") {
              await idbSet("user", event.data.value);
              self.postMessage({ value: event.data.value });
            } else {
              self.postMessage({ value: await idbGet("user") });
            }
          } catch (error) {
            self.postMessage({ error: error.message || String(error) });
          }
        };
        function idbSet(key, value) {
          return new Promise((resolve, reject) => {
            const open = indexedDB.open("worker-state", 1);
            open.onupgradeneeded = () => open.result.createObjectStore("kv");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction("kv", "readwrite");
              tx.objectStore("kv").put(value, key);
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            };
          });
        }
        function idbGet(key) {
          return new Promise((resolve, reject) => {
            const open = indexedDB.open("worker-state", 1);
            open.onupgradeneeded = () => open.result.createObjectStore("kv");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction("kv", "readonly");
              const get = tx.objectStore("kv").get(key);
              get.onsuccess = () => resolve(get.result ?? null);
              get.onerror = () => reject(get.error);
            };
          });
        }
      `);
      return;
    }
    if (url.pathname === "/echo") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ cookie: request.headers.cookie || "" }));
      return;
    }
    if (url.pathname === "/set") {
      const name = url.searchParams.get("name") || "token";
      const value = url.searchParams.get("value") || "value";
      const attrs = [`${name}=${value}`, "Path=/"];
      if (url.searchParams.get("httpOnly")) attrs.push("HttpOnly");
      response.setHeader("set-cookie", attrs.join("; "));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  return new Promise((resolve) => {
    instance.listen(0, "127.0.0.1", () => {
      const { port } = instance.address();
      resolve({ instance, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
