document.addEventListener("DOMContentLoaded", async () => {
  const apiKeyInput = document.getElementById("apiKey");
  const saveBtn = document.getElementById("saveBtn");
  const testBtn = document.getElementById("testBtn");
  const deleteBtn = document.getElementById("deleteBtn");
  const toggleVis = document.getElementById("toggleVis");
  const msgEl = document.getElementById("msg");
  const modelSelect = document.getElementById("model");
  const thresholdSlider = document.getElementById("threshold");
  const thresholdVal = document.getElementById("thresholdVal");

  // Load saved settings
  const stored = await chrome.storage.local.get([
    "openaiApiKey",
    "aiModel",
    "aiThreshold",
  ]);

  if (stored.openaiApiKey) {
    apiKeyInput.value = stored.openaiApiKey;
  }
  if (stored.aiModel) {
    modelSelect.value = stored.aiModel;
  }
  if (stored.aiThreshold !== undefined) {
    thresholdSlider.value = stored.aiThreshold;
    thresholdVal.textContent = `${stored.aiThreshold}%`;
  }

  // Show/hide key
  toggleVis.addEventListener("click", () => {
    const isPassword = apiKeyInput.type === "password";
    apiKeyInput.type = isPassword ? "text" : "password";
    toggleVis.textContent = isPassword ? "🙈" : "👁";
  });

  // Threshold slider
  thresholdSlider.addEventListener("input", () => {
    thresholdVal.textContent = `${thresholdSlider.value}%`;
  });
  thresholdSlider.addEventListener("change", async () => {
    await chrome.storage.local.set({ aiThreshold: parseInt(thresholdSlider.value) });
    showMsg("Threshold saved", "success");
  });

  // Model select
  modelSelect.addEventListener("change", async () => {
    await chrome.storage.local.set({ aiModel: modelSelect.value });
    showMsg("Model preference saved", "success");
  });

  // Save key
  saveBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showMsg("Please enter an API key", "error");
      return;
    }
    if (!key.startsWith("sk-")) {
      showMsg("API key should start with 'sk-'", "error");
      return;
    }
    await chrome.storage.local.set({ openaiApiKey: key });
    showMsg("API key saved! AI analysis is now enabled.", "success");
  });

  // Delete key
  deleteBtn.addEventListener("click", async () => {
    await chrome.storage.local.remove("openaiApiKey");
    apiKeyInput.value = "";
    showMsg("API key removed. Using heuristic-only mode.", "info");
  });

  // Test key
  testBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showMsg("Enter a key first", "error");
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = "Testing...";
    showMsg("Sending test request to OpenAI...", "info");

    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: modelSelect.value,
          messages: [
            {
              role: "user",
              content: "Reply with exactly: OK",
            },
          ],
          max_tokens: 5,
        }),
      });

      if (resp.ok) {
        showMsg("✓ API key is valid and working!", "success");
      } else {
        const err = await resp.json().catch(() => ({}));
        const errMsg =
          err?.error?.message || `HTTP ${resp.status}`;
        showMsg(`✗ API error: ${errMsg}`, "error");
      }
    } catch (e) {
      showMsg(`✗ Network error: ${e.message}`, "error");
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test Key";
    }
  });

  function showMsg(text, type) {
    msgEl.textContent = text;
    msgEl.className = `msg ${type}`;
    clearTimeout(msgEl._timer);
    if (type === "success") {
      msgEl._timer = setTimeout(() => {
        msgEl.className = "msg";
      }, 3000);
    }
  }
});
