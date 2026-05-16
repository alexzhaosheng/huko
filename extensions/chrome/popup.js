// huko browser control — popup status

const dot = document.getElementById("dot");
const statusText = document.getElementById("status");

function setStatus(s) {
  // Reset classes
  dot.className = "dot";

  if (s === "connected") {
    dot.classList.add("connected");
    statusText.textContent = "connected";
  } else if (s.startsWith("reconnecting")) {
    dot.classList.add("reconnecting");
    statusText.textContent = s;
  } else {
    dot.classList.add("disconnected");
    statusText.textContent = s || "disconnected";
  }
}

// Get initial status from background
chrome.runtime.sendMessage({ type: "getStatus" }, (resp) => {
  if (resp) setStatus(resp.status);
  else setStatus("disconnected");
});

// Listen for status updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") {
    setStatus(msg.status);
  }
});

// Refresh button: double-click to reconnect
document.body.addEventListener("dblclick", () => {
  chrome.runtime.sendMessage({ type: "reconnect" });
});
