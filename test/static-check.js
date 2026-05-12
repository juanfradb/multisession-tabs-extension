"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert(manifest.manifest_version === 3, "Manifest must use MV3");
assert(manifest.background?.service_worker === "service-worker.js", "Service worker missing");
assert(manifest.content_scripts?.[0]?.world === "ISOLATED", "Content script bridge must run in ISOLATED world");
assert(manifest.permissions.includes("declarativeNetRequest"), "DNR permission missing");
assert(manifest.permissions.includes("webRequest"), "webRequest permission missing");
assert(manifest.host_permissions.includes("<all_urls>"), "host permissions missing");

for (const file of ["service-worker.js", "content-script.js", "popup.html", "popup.js", "popup.css"]) {
  assert(fs.existsSync(path.join(root, file)), `${file} missing`);
}

const serviceWorker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
assert(serviceWorker.includes('header: "Cookie", operation: "remove"'), "Cookie removal rule missing");
assert(serviceWorker.includes("removeBrowserCookie"), "browser Set-Cookie cleanup missing");
assert(serviceWorker.includes('header: "Cookie", operation: "set"'), "virtual Cookie set rule missing");
for (const token of ["chrome.scripting.executeScript", "document", "localStorage", "sessionStorage", "indexedDB", "caches", "BroadcastChannel", "Worker"]) {
  assert(serviceWorker.includes(token), `${token} page patch missing`);
}
assert(!/chrome-extension:\/\/[a-p]{32}/.test(serviceWorker), "hardcoded extension URL leaked");

const contentScript = fs.readFileSync(path.join(root, "content-script.js"), "utf8");
assert(contentScript.includes("postMessage"), "page bridge missing");
assert(contentScript.includes("chrome.storage.local"), "content bridge storage access missing");

console.log("static checks ok");

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}
