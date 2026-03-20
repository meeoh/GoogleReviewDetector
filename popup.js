document.addEventListener("DOMContentLoaded", async () => {
  const btn = document.getElementById("analyzeBtn");
  const statusEl = document.getElementById("status");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const aiStatusEl = document.getElementById("aiStatus");
  const aiDot = document.getElementById("aiDot");
  const aiText = document.getElementById("aiText");
  const settingsBtn = document.getElementById("settingsBtn");
  const aiConfigure = document.getElementById("aiConfigure");

  // Open settings
  const openSettings = () => chrome.runtime.openOptionsPage();
  settingsBtn.addEventListener("click", openSettings);
  aiConfigure.addEventListener("click", openSettings);

  // Check AI status
  const stored = await chrome.storage.local.get(["openaiApiKey", "aiModel"]);
  if (stored.openaiApiKey) {
    aiStatusEl.classList.add("enabled");
    aiDot.classList.add("purple");
    const model = stored.aiModel || "gpt-4.1-nano";
    aiText.textContent = `AI: enabled (${model})`;
    aiConfigure.textContent = "change";
  } else {
    aiDot.classList.add("gray");
    aiText.textContent = "AI: off — heuristic only";
    aiConfigure.textContent = "add API key";
  }

  // Check if we're on a Google Maps page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isGoogleMaps =
    tab?.url?.includes("google.com/maps") ||
    tab?.url?.includes("maps.google.com");

  if (isGoogleMaps) {
    statusEl.classList.add("active");
    statusDot.classList.remove("red");
    statusDot.classList.add("green");
    statusText.textContent = "Google Maps detected — ready to analyze";
    btn.disabled = false;
  } else {
    statusEl.classList.add("inactive");
    statusText.textContent = "Navigate to a Google Maps business page first";
    btn.disabled = true;
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Analyzing...";
    statusText.textContent = "Scrolling through reviews and analyzing...";

    try {
      await chrome.tabs.sendMessage(tab.id, { action: "analyze" });
      statusText.textContent = "Analysis running on page — check the reviews!";
      btn.textContent = "Analysis Started ✓";
    } catch (e) {
      statusText.textContent = "Error: try refreshing the Maps page";
      btn.textContent = "Retry";
      btn.disabled = false;
    }
  });
});
