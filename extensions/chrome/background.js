// huko browser control — background service worker
//
// Connects to huko's WebSocket server and executes commands
// in the user's real Chrome browser. All logins and cookies
// are live — the agent interacts with what the user sees.

const WS_PORT = 19222;
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;

let ws = null;
let reconnectDelay = 100; // ms, fast reconnect — huko only waits 15s
const RECONNECT_MAX = 5_000;
let reconnectTimer = null;

// ─── Connection ────────────────────────────────────────────────────────────

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  clearReconnect();

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectDelay = 500; // reset backoff
    updateStatus("connected");
    console.log("[huko] connected to huko");
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    handleCommand(msg);
  };

  ws.onclose = () => {
    updateStatus("disconnected");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this
    ws = null;
  };
}

function scheduleReconnect() {
  clearReconnect();
  updateStatus(`reconnecting in ${Math.round(reconnectDelay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
    connect();
  }, reconnectDelay);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ─── Command dispatcher ────────────────────────────────────────────────────

async function handleCommand(msg) {
  const { id, cmd } = msg;

  try {
    let result;
    switch (cmd) {
      case "navigate":
        result = await cmdNavigate(msg.url);
        break;
      case "click":
        result = await cmdClick(msg.selector);
        break;
      case "type":
        result = await cmdType(msg.selector, msg.text);
        break;
      case "scroll":
        result = await cmdScroll(msg.direction);
        break;
      case "get_text":
        result = await cmdGetText();
        break;
      case "get_html":
        result = await cmdGetHtml();
        break;
      case "screenshot":
        result = await cmdScreenshot(msg.selector);
        break;
      case "wait":
        result = await cmdWait(msg.selector, msg.ms);
        break;
      case "list_pages":
        result = await cmdListPages();
        break;
      case "switch_page":
        result = await cmdSwitchPage(msg.index);
        break;
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }

    respond(id, true, result.text, result.attachment);
  } catch (err) {
    respond(id, false, null, null, err.message);
  }
}

function respond(id, ok, text, attachment, error) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = { id, ok };
  if (ok) {
    msg.result = text;
    if (attachment) msg.attachment = attachment;
  } else {
    msg.error = error || "unknown error";
  }
  ws.send(JSON.stringify(msg));
}

// ─── Command implementations ────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab found.");
  return tab;
}

// ─── Injected operation dispatcher (ISOLATED world, no CSP issues) ────────

function pageDispatcher(params) {
  try {
    switch (params.op) {
      case "getText":
        return document.body ? document.body.innerText : document.documentElement.innerText;
      case "getHtml":
        return document.documentElement.outerHTML;
      case "click": {
        const el = document.querySelector(params.sel);
        if (!el) throw new Error("Element not found: " + params.sel);
        el.click();
        return 'Clicked "' + params.sel + '".';
      }
      case "type": {
        const el2 = document.querySelector(params.sel);
        if (!el2) throw new Error("Element not found: " + params.sel);
        el2.focus();
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        if (el2.tagName === "INPUT" && nativeInputValueSetter) {
          nativeInputValueSetter.call(el2, params.text);
        } else if (el2.tagName === "TEXTAREA" && nativeTextareaValueSetter) {
          nativeTextareaValueSetter.call(el2, params.text);
        } else {
          el2.value = params.text;
        }
        el2.dispatchEvent(new Event("input", { bubbles: true }));
        el2.dispatchEvent(new Event("change", { bubbles: true }));
        return 'Typed "' + params.text + '" into "' + params.sel + '".';
      }
      case "scroll":
        switch (params.dir) {
          case "down": window.scrollBy(0, 300); break;
          case "up": window.scrollBy(0, -300); break;
          case "top": window.scrollTo(0, 0); break;
          case "bottom": window.scrollTo(0, document.body.scrollHeight); break;
          default: return "Unknown direction: " + params.dir;
        }
        return "Scrolled " + params.dir + ".";
      default:
        return "Unknown op: " + params.op;
    }
  } catch (e) {
    return "!!ERR:" + e.message;
  }
}

async function executeOpInTab(tabId, params) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageDispatcher,
    args: [params],
    world: "ISOLATED",
  });
  return results[0]?.result;
}

// ─── navigate ──────────────────────────────────────────────────────────────

async function cmdNavigate(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabLoad(tab.id);
  const text = await executeOpInTab(tab.id, { op: "getText" });
  return { text: text || "(page has no visible text)" };
}

async function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (tab.status === "complete") {
          resolve();
        } else {
          setTimeout(check, 200);
        }
      });
    };
    check();
  });
}

// ─── click ─────────────────────────────────────────────────────────────────

async function cmdClick(selector) {
  const tab = await getActiveTab();
  const result = await executeOpInTab(tab.id, { op: "click", sel: selector });
  return { text: result };
}

// ─── type ──────────────────────────────────────────────────────────────────

async function cmdType(selector, text) {
  const tab = await getActiveTab();
  const result = await executeOpInTab(tab.id, { op: "type", sel: selector, text });
  return { text: result };
}

// ─── scroll ────────────────────────────────────────────────────────────────

async function cmdScroll(direction) {
  const tab = await getActiveTab();
  const result = await executeOpInTab(tab.id, { op: "scroll", dir: direction });
  return { text: result };
}

// ─── get_text ──────────────────────────────────────────────────────────────

async function cmdGetText() {
  const tab = await getActiveTab();
  const text = await executeOpInTab(tab.id, { op: "getText" });
  return { text: text || "(page has no visible text)" };
}

// ─── get_html ──────────────────────────────────────────────────────────────

async function cmdGetHtml() {
  const tab = await getActiveTab();
  const html = await executeOpInTab(tab.id, { op: "getHtml" });
  return { text: html };
}

// ─── screenshot ────────────────────────────────────────────────────────────

async function cmdScreenshot(selector) {
  // captureVisibleTab returns a data URL: data:image/png;base64,...
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
  // Extract base64
  const base64 = dataUrl.split(",")[1] || "";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    text: `Screenshot captured (visible tab).`,
    attachment: {
      filename: `screenshot-${timestamp}.png`,
      data: base64,
    },
  };
}

// ─── wait ──────────────────────────────────────────────────────────────────

async function cmdWait(selector, ms) {
  if (selector) {
    const tab = await getActiveTab();
    return new Promise((resolve) => {
      const start = Date.now();
      const timeout = 30000;
      const check = () => {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => !!document.querySelector(sel),
          args: [selector],
          world: "ISOLATED",
        }).then(([res]) => {
          if (res?.result) {
            resolve({ text: `Element "${selector}" appeared.` });
          } else if (Date.now() - start > timeout) {
            resolve({ text: `Timeout waiting for "${selector}".` });
          } else {
            setTimeout(check, 500);
          }
        });
      };
      check();
    });
  }
  if (ms && ms > 0) {
    await new Promise((r) => setTimeout(r, Math.min(ms, 30000)));
    return { text: `Waited ${ms}ms.` };
  }
  return { text: "Wait requires either a selector or ms parameter." };
}

// ─── list_pages ────────────────────────────────────────────────────────────

async function cmdListPages() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const pages = tabs.map((t, i) => ({
    index: t.index ?? i,
    url: t.url ?? t.pendingUrl ?? "",
    title: t.title ?? "",
    active: t.active ?? false,
  }));
  return { text: JSON.stringify(pages) };
}

// ─── switch_page ───────────────────────────────────────────────────────────

async function cmdSwitchPage(index) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  if (index < 0 || index >= tabs.length) {
    return { text: `Invalid page index ${index}. 0-${tabs.length - 1} available.` };
  }
  const tab = tabs[index];
  if (!tab || !tab.id) {
    return { text: `Page ${index} is unavailable.` };
  }
  await chrome.tabs.update(tab.id, { active: true });
  return { text: `Switched to page ${index}: ${tab.title}  ${tab.url}` };
}

// ─── Status reporting ──────────────────────────────────────────────────────

let currentStatus = "disconnected";

function updateStatus(status) {
  currentStatus = status;
  // Notify popup if open
  chrome.runtime.sendMessage({ type: "status", status }).catch(() => {
    // popup is not open — ignore
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getStatus") {
    sendResponse({ status: currentStatus, port: WS_PORT });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

try {
  connect();
} catch (err) {
  console.error("[huko] startup error:", err);
}
