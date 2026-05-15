// huko browser control — background service worker v2
//
// Connects to huko's WebSocket server and executes commands
// in the user's real Chrome browser. All logins and cookies
// are live — the agent interacts with what the user sees.
//
// v2 adds AI-powered element finding: the extension can collect
// all visible interactive elements (@e1, @e2, ...) so the LLM can
// pick targets by natural language description instead of brittle
// CSS selectors.

const WS_PORT = 19222;
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;

let ws = null;
let reconnectDelay = 100;
const RECONNECT_MAX = 5_000;
let reconnectTimer = null;
const KEEPALIVE_ALARM = "keepalive";
const KEEPALIVE_MINUTES = 0.5;

// ─── Connection ────────────────────────────────────────────────────────────

let pendingWork = Promise.resolve();

function closeWs() {
  if (ws) {
    try { ws.close(); } catch { /* best-effort */ }
    ws = null;
  }
}

function connect() {
  clearReconnect();
  closeWs();

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectDelay = 500;
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
    pendingWork = handleCommand(msg).catch((err) => {
      console.error("[huko] handleCommand error:", err);
    });
  };

  ws.onclose = () => {
    updateStatus("disconnected");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    closeWs();
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
      case "ping":
        result = { text: "pong" };
        break;
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
      // ── v2: element ref commands ──────────────────────────────
      case "find":
        result = await cmdFind();
        break;
      case "click_ref":
        result = await cmdClickRef(msg.ref);
        break;
      case "type_ref":
        result = await cmdTypeRef(msg.ref, msg.text);
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

// ─── Injected functions (ISOLATED world) ───────────────────────────────────

/**
 * Standard page dispatcher — processes simple ops: getText, getHtml,
 * click (by CSS selector), type, scroll.
 */
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
        if (el2.getAttribute("contenteditable") === "true" || el2.isContentEditable) {
          // contenteditable div (e.g. Quill editor) — use textContent
          el2.textContent = params.text;
          el2.dispatchEvent(new Event("input", { bubbles: true }));
          el2.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
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
        }
        return 'Typed "' + params.text + '" into "' + params.sel + '".';
      }
      case "scroll": {
        // Try window-level scroll first.
        const before = window.scrollY;
        switch (params.dir) {
          case "down":  window.scrollBy(0, 300); break;
          case "up":    window.scrollBy(0, -300); break;
          case "top":   window.scrollTo(0, 0); break;
          case "bottom":window.scrollTo(0, document.body.scrollHeight); break;
          default: return "Unknown direction: " + params.dir;
        }
        if (window.scrollY !== before) return "Scrolled " + params.dir + ".";

        // Window didn't scroll — find the best scrollable container.
        // Strategy: scan ALL scrollable elements, pick the one with the
        // largest visible area that overlaps the viewport.
        const all = document.querySelectorAll("*");
        let best = null;
        let bestArea = 0;
        for (const el of all) {
          if (el.scrollHeight <= el.clientHeight) continue;
          const s = getComputedStyle(el);
          if (s.overflowY !== "auto" && s.overflowY !== "scroll" && s.overflow !== "auto" && s.overflow !== "scroll") continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // Compute overlap area with viewport.
          const overlapW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
          const overlapH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
          if (overlapW <= 0 || overlapH <= 0) continue;
          const area = overlapW * overlapH;
          if (area > bestArea) { bestArea = area; best = el; }
        }
        if (best) {
          const topBefore = best.scrollTop;
          switch (params.dir) {
            case "down":   best.scrollTop += 300; break;
            case "up":     best.scrollTop -= 300; break;
            case "top":    best.scrollTop = 0; break;
            case "bottom": best.scrollTop = best.scrollHeight; break;
          }
          return best.scrollTop !== topBefore
            ? "Scrolled " + params.dir + "."
            : "Scrolled " + params.dir + " (no effect — container at scroll limit).";
        }
        return "Scrolled " + params.dir + " (no effect — no scrollable container found).";
      }
      // ── v2: element-ref ops ──────────────────────────────────
      case "clickRef": {
        const idx = _hukoElementRefs[params.ref];
        if (idx === undefined) throw new Error("Element ref not found: @" + params.ref);
        const { x, y } = _hukoElementPositions[idx];
        const clickEl = document.elementFromPoint(x, y);
        if (clickEl) {
          clickEl.click();
        } else {
          throw new Error("No element at position for ref @" + params.ref);
        }
        return 'Clicked @' + params.ref + '.';
      }
      case "typeRef": {
        const idx2 = _hukoElementRefs[params.ref];
        if (idx2 === undefined) throw new Error("Element ref not found: @" + params.ref);
        const el3 = document.querySelector(`[data-huko-ref="${params.ref}"]`);
        if (!el3) throw new Error("Element @" + params.ref + " no longer in DOM.");
        el3.focus();
        if (el3.getAttribute("contenteditable") === "true" || el3.isContentEditable) {
          el3.textContent = params.text;
          el3.dispatchEvent(new Event("input", { bubbles: true }));
          el3.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          const iSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          const tSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
          if (el3.tagName === "INPUT" && iSetter) {
            iSetter.call(el3, params.text);
          } else if (el3.tagName === "TEXTAREA" && tSetter) {
            tSetter.call(el3, params.text);
          } else {
            el3.value = params.text;
          }
          el3.dispatchEvent(new Event("input", { bubbles: true }));
          el3.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return 'Typed "' + params.text + '" into @' + params.ref + '.';
      }
      default:
        return "Unknown op: " + params.op;
    }
  } catch (e) {
    return "!!ERR:" + e.message;
  }
}

/**
 * Collect all visible interactive elements on the page, assign @eN refs,
 * and return a compact text snapshot suitable for LLM element picking.
 *
 * Each element gets a unique `data-huko-ref` attribute so it can be
 * targeted by `click_ref` / `type_ref` later.  The return value is a
 * JSON string with `{ snapshot, refs, positions }`.
 */
function pageFindElements() {
  // Clean up refs from a previous call.
  document.querySelectorAll("[data-huko-ref]").forEach(function(el) {
    el.removeAttribute("data-huko-ref");
  });

  const SELECTOR = "a, button, input, select, textarea, [role=button], [role=link], [role=menuitem], [role=option], [role=tab], [onclick], [tabindex]:not([tabindex='-1']), [contenteditable='true']";
  const all = document.querySelectorAll(SELECTOR);
  const refs = {};
  const positions = [];
  const lines = [];
  let n = 0;

  for (const el of all) {
    // Visibility check: skip hidden / zero-size elements.
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;

    n++;
    const ref = String(n);
    refs[ref] = n - 1;
    positions.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

    // Mark element so clickRef/typeRef can find it via coordinate or DOM attribute.
    el.setAttribute("data-huko-ref", ref);

    // Build a concise description line.
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") || "";
    const text = (el.textContent || "").trim().slice(0, 80);
    const aria = el.getAttribute("aria-label") || "";
    const placeholder = el.getAttribute("placeholder") || "";
    const role = el.getAttribute("role") || "";
    const name = el.getAttribute("name") || "";
    const idAttr = el.id ? "#" + el.id : "";

    const desc = [tag];
    if (type) desc.push("[" + type + "]");
    if (role) desc.push("(role=" + role + ")");
    if (aria && aria !== text) desc.push('"' + aria + '"');
    if (text && text !== aria) desc.push('"' + text + '"');
    if (placeholder) desc.push('placeholder="' + placeholder + '"');
    if (name) desc.push('name="' + name + '"');
    if (idAttr) desc.push(idAttr);

    lines.push("  @" + ref + " " + desc.join(" "));
  }

  const snapshot = "Interactive elements on page (" + n + " total):\n" + lines.join("\n");

  // Store refs + positions on window so clickRef/typeRef can access them.
  window._hukoElementRefs = refs;
  window._hukoElementPositions = positions;

  return JSON.stringify({ snapshot, ref_count: n, refs: Object.keys(refs) });
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

async function executeFindInTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageFindElements,
    world: "ISOLATED",
  });
  return results[0]?.result;
}

// ─── navigate ──────────────────────────────────────────────────────────────

async function cmdNavigate(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabLoad(tab.id);

  // Collect page text and interactive elements snapshot in parallel.
  const text = await executeOpInTab(tab.id, { op: "getText" });
  let snapshot = "";
  try {
    const raw = await executeFindInTab(tab.id);
    if (raw) {
      const data = JSON.parse(raw);
      snapshot = "\n\n" + data.snapshot;
    }
  } catch {
    // Element finding is best-effort; page text alone is still useful.
  }

  return {
    text: (text || "(page has no visible text)") + snapshot,
  };
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

// ─── click (CSS selector) ──────────────────────────────────────────────────

async function cmdClick(selector) {
  const tab = await getActiveTab();
  const result = await executeOpInTab(tab.id, { op: "click", sel: selector });
  return { text: result };
}

// ─── type (CSS selector) ───────────────────────────────────────────────────

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
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
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

// ─── wait ─────────────────────────────────────────────────────────────────

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

// ─── switch_page ──────────────────────────────────────────────────────────

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

// ─── v2: find — get interactive element list ──────────────────────────────

async function cmdFind() {
  const tab = await getActiveTab();
  const raw = await executeFindInTab(tab.id);
  if (!raw) return { text: "No interactive elements found." };
  try {
    const data = JSON.parse(raw);
    return { text: data.snapshot };
  } catch {
    return { text: raw };
  }
}

// ─── v2: click by element ref ─────────────────────────────────────────────

async function cmdClickRef(ref) {
  const tab = await getActiveTab();
  const result = await executeOpInTab(tab.id, { op: "clickRef", ref });
  return { text: result };
}

// ─── v2: type by element ref ──────────────────────────────────────────────

async function cmdTypeRef(ref, text) {
  const tab = await getActiveTab();
  const result = await executeOpInTab(tab.id, { op: "typeRef", ref, text });
  return { text: result };
}

// ─── Status reporting ──────────────────────────────────────────────────────

let currentStatus = "disconnected";

async function updateStatus(status) {
  currentStatus = status;
  const prefix = status === "connected" ? "huko" : "huko_red";
  try {
    await chrome.action.setIcon({
      path: {
        16: `${prefix}-16.png`,
        48: `${prefix}-48.png`,
        128: `${prefix}-128.png`,
      },
    });
    if (chrome.runtime.lastError) {
      console.error("[huko] setIcon runtime.lastError:", chrome.runtime.lastError.message);
    } else {
      console.log("[huko] icon updated:", status);
    }
  } catch (err) {
    console.error("[huko] setIcon failed:", err);
  }
  chrome.runtime.sendMessage({ type: "status", status }).catch(() => {
    // popup is not open — ignore
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getStatus") {
    sendResponse({ status: currentStatus, port: WS_PORT });
  } else if (msg.type === "reconnect") {
    clearReconnect();
    reconnectDelay = 100;
    connect();
    sendResponse({ status: currentStatus });
  }
});

// ─── Alarm keepalive ───────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearReconnect();
      reconnectDelay = 100;
      connect();
    }
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

async function ensureAlarm() {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (!existing) {
    await chrome.alarms.create(KEEPALIVE_ALARM, {
      periodInMinutes: KEEPALIVE_MINUTES,
    });
  }
}

try {
  connect();
  ensureAlarm().catch((err) => console.error("[huko] alarm error:", err));
} catch (err) {
  console.error("[huko] startup error:", err);
}
