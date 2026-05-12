# MultiSession Tabs

Chrome MV3 extension for running same-site accounts in different tabs in one window.

## What it isolates

- HTTP cookies per assigned tab session, including `Set-Cookie` response headers and `document.cookie`.
- `localStorage` and `sessionStorage` by transparent key prefixing.
- `IndexedDB`, `CacheStorage`, and `BroadcastChannel` by session prefix.
- Worker and shared worker scripts get the same IndexedDB/cache/channel prefix when the script is same-origin and fetchable.

## How it works

The popup creates named sessions for the current hostname. Opening or assigning a session stores a tab-to-session mapping in `chrome.storage.session`.

For assigned tabs, the service worker installs tab-scoped `declarativeNetRequest` rules:

- remove the browser profile's normal `Cookie` request header;
- capture `Set-Cookie` response headers into the selected session and clean matching cookies from the normal cookie jar;
- set a virtual `Cookie` request header from the selected session's stored cookies.

The service worker injects a main-world page patcher for assigned tabs. The isolated content script stays as the bridge for cookie writes back into extension storage.

## Existing projects inspected

- SessionHub extension build: useful DNR + storage-prefix architecture, but minified and hardcoded to store its own extension ID.
- Sessify open source: `Deri-Kurniawan/sessify-browser-extension`, MIT. It snapshots and restores cookies/storage, but does not provide concurrent same-domain tab isolation.
- Session Stash open source: `ianchenx/session-stash`, MIT. It snapshots cookies/localStorage and syncs them, but also swaps active browser state instead of isolating concurrent same-domain tabs.
- MultiLogin Tabs store listing: documents target behavior: per-tab cookies, `localStorage`, `IndexedDB`, and cache isolation.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load unpacked.
4. Select this repository folder.

## Test

```bash
npm install
npm run install:browser
npm test
```
