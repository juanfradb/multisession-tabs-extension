"use strict";

const MSG = {
  GET_STATE: "popup:getState",
  CREATE_SESSION: "session:create",
  OPEN_SESSION: "session:open",
  ASSIGN_TAB: "tab:assign",
  CLEAR_TAB: "tab:clear"
};

const elements = {
  site: document.getElementById("site"),
  status: document.getElementById("status"),
  unsupported: document.getElementById("unsupported"),
  controls: document.getElementById("controls"),
  sessions: document.getElementById("sessions"),
  list: document.getElementById("session-list"),
  name: document.getElementById("session-name"),
  newTab: document.getElementById("new-tab"),
  useHere: document.getElementById("use-here"),
  leave: document.getElementById("leave")
};

let state = null;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
elements.newTab.addEventListener("click", () => createSession("new"));
elements.useHere.addEventListener("click", () => createSession("current"));
elements.leave.addEventListener("click", async () => {
  await send({ type: MSG.CLEAR_TAB });
  window.close();
});

async function init() {
  try {
    state = await send({ type: MSG.GET_STATE });
    render();
  } catch (error) {
    renderError(error.message || String(error));
  }
}

async function createSession(mode) {
  const name = elements.name.value.trim();
  const response = await send({ type: MSG.CREATE_SESSION, mode, name });
  if (response?.ok) window.close();
  else renderError(response?.error || "Failed");
}

async function openSession(sessionId) {
  const response = await send({ type: MSG.OPEN_SESSION, sessionId, url: state.tab.url });
  if (response?.ok) window.close();
  else renderError(response?.error || "Failed");
}

async function assignSession(sessionId) {
  const response = await send({ type: MSG.ASSIGN_TAB, sessionId, url: state.tab.url });
  if (response?.ok) window.close();
  else renderError(response?.error || "Failed");
}

function render() {
  if (!state?.ok) {
    renderError(state?.error || "Failed");
    return;
  }
  elements.site.textContent = state.siteKey || "Unsupported page";
  elements.unsupported.hidden = state.supported;
  elements.controls.hidden = !state.supported;
  elements.sessions.hidden = !state.supported || state.sessions.length === 0;
  elements.leave.hidden = !state.assignment;
  elements.status.style.background = state.assignment?.color || "#cbd5e1";
  elements.status.title = state.assignment ? state.assignment.name : "Normal browser session";
  elements.list.textContent = "";

  for (const session of state.sessions) {
    const item = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = session.color;
    const label = document.createElement("span");
    label.innerHTML = `<span class="name"></span><span class="meta"></span>`;
    label.querySelector(".name").textContent = session.name;
    label.querySelector(".meta").textContent = `${session.cookieCount} cookies`;
    const open = button("Open", () => openSession(session.id));
    const here = button("Here", () => assignSession(session.id));
    item.append(dot, label, open, here);
    elements.list.append(item);
  }
}

function renderError(message) {
  elements.site.textContent = message;
  elements.unsupported.hidden = false;
  elements.controls.hidden = true;
  elements.sessions.hidden = true;
}

function button(text, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "small secondary";
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

function send(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Extension background did not respond")), 3000);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}
