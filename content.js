// ============================================================
// Review Detective — Content Script
// Scrapes Google Maps reviews from the DOM and analyzes them
// for fake/bot signals, then annotates the page.
// Optionally uses OpenAI for a second opinion on suspicious reviews.
// ============================================================

(() => {
  "use strict";

  // Prevent double-injection
  if (window.__reviewDetectiveLoaded) return;
  window.__reviewDetectiveLoaded = true;

  // ----------------------------------------------------------
  // SIGNAL DEFINITIONS
  // Each signal returns { score: 0-1, reason: string }
  // ----------------------------------------------------------

  const SIGNALS = [
    {
      name: "low_review_count",
      weight: 2.0,
      fn: (review, _ctx) => {
        const n = review.reviewerTotalReviews;
        if (n === null) return { score: 0.3, reason: "Review count unknown" };
        if (n <= 1) return { score: 0.85, reason: `Only ${n} review — possible throwaway account` };
        if (n <= 3) return { score: 0.55, reason: `Only ${n} reviews` };
        if (n <= 5) return { score: 0.2, reason: `${n} reviews` };
        return { score: 0.0, reason: `${n} reviews — established` };
      },
    },
    {
      name: "no_photos",
      weight: 1.0,
      fn: (review, _ctx) => {
        const n = review.reviewerTotalPhotos;
        if (n === null) return { score: 0.2, reason: "Photo count unknown" };
        if (n === 0) return { score: 0.4, reason: "Never posted photos" };
        return { score: 0.0, reason: `${n} photos posted` };
      },
    },
    {
      name: "short_text",
      weight: 1.5,
      fn: (review, _ctx) => {
        const text = (review.text || "").trim();
        if (!text) return { score: 0.5, reason: "No review text — rating only" };
        const words = text.split(/\s+/).length;
        if (words <= 3) return { score: 0.6, reason: `Extremely short (${words} words)` };
        if (words <= 8) return { score: 0.3, reason: `Short review (${words} words)` };
        return { score: 0.0, reason: `${words} words` };
      },
    },
    {
      name: "generic_text",
      weight: 1.5,
      fn: (review, _ctx) => {
        const text = (review.text || "").trim().toLowerCase();
        if (!text) return { score: 0.3, reason: "No text to evaluate" };
        const generics = [
          /^(great|good|nice|awesome|excellent|amazing|wonderful|best|love it|highly recommend)[.!\s]*$/,
          /^(terrible|worst|horrible|awful|bad|never again)[.!\s]*$/,
          /^(5 stars?|1 star)[.!\s]*$/,
          /^(recommended|not recommended)[.!\s]*$/,
          /^[\W\s]*$/,
        ];
        for (const re of generics) {
          if (re.test(text)) return { score: 0.7, reason: `Generic phrase: "${text}"` };
        }
        if ((text.match(/!/g) || []).length > 5)
          return { score: 0.35, reason: "Excessive exclamation marks" };
        const noEmoji = text.replace(/[\u{1F600}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}]/gu, "").trim();
        if (!noEmoji) return { score: 0.6, reason: "Review is emoji-only" };
        return { score: 0.0, reason: "Text appears specific" };
      },
    },
    {
      name: "extreme_rating",
      weight: 0.5,
      fn: (review, _ctx) => {
        if (review.rating === 5) return { score: 0.15, reason: "5★ — common in fake positive reviews" };
        if (review.rating === 1) return { score: 0.15, reason: "1★ — common in fake negative reviews" };
        return { score: 0.0, reason: `${review.rating}★ — moderate` };
      },
    },
    {
      name: "not_local_guide",
      weight: 0.8,
      fn: (review, _ctx) => {
        if (review.isLocalGuide) return { score: 0.0, reason: "Local Guide — more trustworthy" };
        return { score: 0.25, reason: "Not a Local Guide" };
      },
    },
    {
      name: "rating_vs_average",
      weight: 1.0,
      fn: (review, ctx) => {
        if (!ctx.avgRating) return { score: 0.0, reason: "No business average" };
        const diff = Math.abs(review.rating - ctx.avgRating);
        if (diff >= 3) return { score: 0.4, reason: `${review.rating}★ deviates ${diff.toFixed(1)} from avg ${ctx.avgRating.toFixed(1)}` };
        if (diff >= 2) return { score: 0.2, reason: `Deviates ${diff.toFixed(1)} from avg` };
        return { score: 0.0, reason: "Close to average" };
      },
    },
    {
      name: "review_burst",
      weight: 2.0,
      fn: (review, ctx) => {
        if (!review.dateText || !ctx.allReviews) return { score: 0.0, reason: "Cannot assess timing" };
        const sameDate = ctx.allReviews.filter(
          (r) => r !== review && r.dateText === review.dateText
        ).length;
        const total = ctx.allReviews.length;
        const ratio = sameDate / total;
        if (ratio >= 0.4 && sameDate >= 5)
          return { score: 0.7, reason: `${sameDate + 1} reviews from "${review.dateText}" — suspicious burst` };
        if (ratio >= 0.25 && sameDate >= 4)
          return { score: 0.5, reason: `${sameDate + 1} reviews from "${review.dateText}"` };
        if (ratio >= 0.15 && sameDate >= 3)
          return { score: 0.2, reason: `${sameDate + 1} reviews share this time window` };
        return { score: 0.0, reason: "Normal timing" };
      },
    },
    {
      name: "duplicate_text",
      weight: 3.0,
      fn: (review, ctx) => {
        const text = (review.text || "").trim().toLowerCase();
        if (!text || text.length < 20 || !ctx.allReviews) return { score: 0.0, reason: "N/A" };
        const words = new Set(text.split(/\s+/));
        let dupes = 0;
        for (const other of ctx.allReviews) {
          if (other === review) continue;
          const otherText = (other.text || "").trim().toLowerCase();
          if (otherText.length < 20) continue;
          const otherWords = new Set(otherText.split(/\s+/));
          const intersection = [...words].filter((w) => otherWords.has(w)).length;
          const union = new Set([...words, ...otherWords]).size;
          if (union > 0 && intersection / union > 0.8) dupes++;
        }
        if (dupes >= 1) return { score: 0.9, reason: `Near-duplicate of ${dupes} other review(s)` };
        return { score: 0.0, reason: "No duplicates found" };
      },
    },
    {
      name: "paid_keywords",
      weight: 1.0,
      fn: (review, _ctx) => {
        const text = (review.text || "").toLowerCase();
        const keywords = [
          "as described", "just as advertised", "everything was perfect",
          "will definitely come back", "can't say enough good things",
          "exceeded my expectations", "hidden gem", "must visit",
          "don't listen to the negative reviews", "ignore the bad reviews",
          "five stars", "5 stars", "best in the city", "best in town",
        ];
        const found = keywords.filter((kw) => text.includes(kw));
        if (found.length >= 2) return { score: 0.6, reason: `Paid-review keywords: ${found.slice(0, 3).join(", ")}` };
        if (found.length === 1) return { score: 0.2, reason: `Keyword: "${found[0]}"` };
        return { score: 0.0, reason: "No suspicious keywords" };
      },
    },
    {
      name: "suspicious_name",
      weight: 1.2,
      fn: (review, _ctx) => {
        const name = (review.reviewerName || "").trim();
        if (!name || name.toLowerCase() === "a google user")
          return { score: 0.6, reason: `Placeholder name: "${name || "empty"}"` };
        if (name.length <= 2) return { score: 0.5, reason: `Very short name: "${name}"` };
        return { score: 0.0, reason: "Normal name" };
      },
    },
    {
      name: "all_caps_text",
      weight: 0.6,
      fn: (review, _ctx) => {
        const text = (review.text || "").trim();
        if (!text || text.length < 10) return { score: 0.0, reason: "N/A" };
        const letters = text.replace(/[^a-zA-Z]/g, "");
        if (letters.length > 5 && letters === letters.toUpperCase())
          return { score: 0.5, reason: "ALL CAPS text — often bot-generated" };
        return { score: 0.0, reason: "Normal casing" };
      },
    },
  ];

  // ----------------------------------------------------------
  // DOM SCRAPING — Extract review data from Google Maps
  // ----------------------------------------------------------

  function getBusinessInfo() {
    const nameEl =
      document.querySelector('h1.DUwDvf') ||
      document.querySelector('[data-attrid="title"]') ||
      document.querySelector('h1');
    const name = nameEl?.textContent?.trim() || "Unknown Business";

    const ratingEl =
      document.querySelector('div.F7nice span[aria-hidden="true"]') ||
      document.querySelector('span.ceNzKf') ||
      document.querySelector('span[role="img"]');
    let avgRating = null;
    if (ratingEl) {
      const match = ratingEl.textContent?.match(/([\d.]+)/);
      if (match) avgRating = parseFloat(match[1]);
    }

    const reviewCountEl = document.querySelector('span[aria-label*="reviews"]');
    let totalReviews = null;
    if (reviewCountEl) {
      const match = reviewCountEl.textContent?.match(/([\d,]+)/);
      if (match) totalReviews = parseInt(match[1].replace(/,/g, ""));
    }

    return { name, avgRating, totalReviews };
  }

  function scrapeReviews() {
    const reviewEls = document.querySelectorAll('[data-review-id]');
    const reviews = [];

    for (const el of reviewEls) {
      try {
        const nameEl = el.querySelector('.d4r55') || el.querySelector('button[data-review-id] div.WNxzHc');
        const reviewerName = nameEl?.textContent?.trim() || "Unknown";

        const badgeEl = el.querySelector('.RfnDt') || el.querySelector('[data-review-id] .NBa7we');
        const badgeText = badgeEl?.textContent || "";
        const isLocalGuide = badgeText.toLowerCase().includes("local guide");

        let reviewerTotalReviews = null;
        let reviewerTotalPhotos = null;
        const statsEl = el.querySelector('.RfnDt') || badgeEl;
        if (statsEl) {
          const statsText = statsEl.textContent || "";
          const revMatch = statsText.match(/([\d,]+)\s*review/i);
          const photoMatch = statsText.match(/([\d,]+)\s*photo/i);
          if (revMatch) reviewerTotalReviews = parseInt(revMatch[1].replace(/,/g, ""));
          if (photoMatch) reviewerTotalPhotos = parseInt(photoMatch[1].replace(/,/g, ""));
        }

        const ratingEl = el.querySelector('span.kvMYJc') || el.querySelector('[role="img"][aria-label*="star"]');
        let rating = 0;
        if (ratingEl) {
          const ariaLabel = ratingEl.getAttribute("aria-label") || "";
          const match = ariaLabel.match(/([\d])/);
          if (match) rating = parseInt(match[1]);
        }

        const dateEl = el.querySelector('.rsqaWe') || el.querySelector('span.dehysf');
        const dateText = dateEl?.textContent?.trim() || "";

        const moreBtn = el.querySelector('button.w8nwRe');
        if (moreBtn) moreBtn.click();

        const textEl = el.querySelector('.wiI7pd') || el.querySelector('[data-review-id] .MyEned span');
        const text = textEl?.textContent?.trim() || "";

        const likesEl = el.querySelector('button.GBkF3d span') || el.querySelector('[aria-label*="helpful"]');
        let likes = 0;
        if (likesEl) {
          const m = likesEl.textContent?.match(/(\d+)/);
          if (m) likes = parseInt(m[1]);
        }

        const ownerEl = el.querySelector('.CDe7pd');
        const ownerResponse = ownerEl?.textContent?.trim() || null;

        reviews.push({
          element: el,
          reviewId: el.getAttribute("data-review-id"),
          reviewerName,
          isLocalGuide,
          reviewerTotalReviews,
          reviewerTotalPhotos,
          rating,
          dateText,
          text,
          likes,
          ownerResponse,
        });
      } catch (e) {
        console.warn("[Review Detective] Error scraping review:", e);
      }
    }

    return reviews;
  }

  // ----------------------------------------------------------
  // ANALYSIS ENGINE
  // ----------------------------------------------------------

  function analyzeReview(review, ctx) {
    const results = [];
    for (const signal of SIGNALS) {
      const { score, reason } = signal.fn(review, ctx);
      results.push({
        name: signal.name,
        weight: signal.weight,
        score,
        reason,
      });
    }

    const totalWeight = results.reduce((s, r) => s + r.weight, 0);
    const weightedScore = totalWeight > 0
      ? results.reduce((s, r) => s + r.score * r.weight, 0) / totalWeight
      : 0;

    return { signals: results, heuristicScore: weightedScore };
  }

  function computeVerdict(score) {
    if (score >= 0.70) return "VERY LIKELY FAKE";
    if (score >= 0.50) return "LIKELY FAKE";
    if (score >= 0.35) return "SUSPICIOUS";
    if (score >= 0.20) return "SLIGHTLY SUSPICIOUS";
    return "LIKELY GENUINE";
  }

  // ----------------------------------------------------------
  // LLM INTEGRATION — Optional OpenAI analysis
  // ----------------------------------------------------------

  async function getAISettings() {
    try {
      const stored = await chrome.storage.local.get([
        "openaiApiKey",
        "aiModel",
        "aiThreshold",
      ]);
      return {
        apiKey: stored.openaiApiKey || null,
        model: stored.aiModel || "gpt-4.1-nano",
        threshold: (stored.aiThreshold ?? 30) / 100, // convert from percentage
      };
    } catch (e) {
      console.warn("[Review Detective] Could not read AI settings:", e);
      return { apiKey: null, model: "gpt-4.1-nano", threshold: 0.30 };
    }
  }

  async function llmAnalyzeBatch(reviewsToAnalyze, bizInfo, apiKey, model) {
    const SYSTEM_PROMPT = `You are an expert at detecting fake Google reviews. You will receive a batch of reviews as a JSON array. For each review, determine how likely it is to be fake/bot-generated.

Consider these factors:
- Does the text read naturally or feel templated/AI-generated?
- Is the review suspiciously vague or overly specific in a promotional way?
- Does the language feel like authentic customer feedback or marketing copy?
- Are there signs of emotional manipulation or urgency?
- Does the review contain specific details about the experience (genuine signal)?
- Does the sentiment match the star rating?
- Could this be astroturfing (competitor attack or paid promotion)?

Respond with a JSON object: {"results": [{"index": 0, "fake_probability": 0.0-1.0, "reasoning": "1-2 sentences"}, ...]}

Be well-calibrated. Most reviews ARE genuine. Only flag reviews with clear suspicious patterns.`;

    const reviewData = reviewsToAnalyze.map((item, i) => ({
      index: i,
      reviewer_name: item.review.reviewerName,
      reviewer_total_reviews: item.review.reviewerTotalReviews,
      reviewer_total_photos: item.review.reviewerTotalPhotos,
      is_local_guide: item.review.isLocalGuide,
      rating: item.review.rating,
      date: item.review.dateText,
      text: item.review.text || "(no text)",
      likes: item.review.likes,
      owner_responded: !!item.review.ownerResponse,
    }));

    // Batch into groups of 10 to stay within token limits
    const BATCH_SIZE = 10;
    const allResults = [];

    for (let start = 0; start < reviewData.length; start += BATCH_SIZE) {
      const batch = reviewData.slice(start, start + BATCH_SIZE);

      const userMsg =
        `Business: ${bizInfo.name} (avg rating: ${bizInfo.avgRating || "unknown"})\n\n` +
        `Reviews to analyze:\n${JSON.stringify(batch, null, 2)}`;

      try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMsg },
            ],
            response_format: { type: "json_object" },
            temperature: 0.2,
            max_tokens: 1500,
          }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          console.warn(`[Review Detective] AI API error (batch ${start}):`, err?.error?.message || resp.status);
          // Fill with nulls — graceful fallback
          for (let i = 0; i < batch.length; i++) {
            allResults.push(null);
          }
          continue;
        }

        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content;
        const parsed = JSON.parse(content);
        const results = parsed.results || [];

        // Map results back, handling missing/malformed entries
        for (let i = 0; i < batch.length; i++) {
          const match = results.find((r) => r.index === i);
          if (match && typeof match.fake_probability === "number") {
            allResults.push({
              fakeProbability: Math.max(0, Math.min(1, match.fake_probability)),
              reasoning: match.reasoning || "",
            });
          } else {
            allResults.push(null);
          }
        }
      } catch (e) {
        console.warn(`[Review Detective] AI request failed (batch ${start}):`, e.message);
        for (let i = 0; i < batch.length; i++) {
          allResults.push(null);
        }
      }
    }

    return allResults;
  }

  // ----------------------------------------------------------
  // UI — Badge & Tooltip injection
  // ----------------------------------------------------------

  function getScoreColor(score) {
    if (score >= 0.70) return "#d32f2f";
    if (score >= 0.50) return "#f44336";
    if (score >= 0.35) return "#ff9800";
    if (score >= 0.20) return "#ffeb3b";
    return "#4caf50";
  }

  function getBadgeClass(verdict) {
    if (verdict === "VERY LIKELY FAKE") return "rd-badge-fake";
    if (verdict === "LIKELY FAKE") return "rd-badge-likely-fake";
    if (verdict === "SUSPICIOUS") return "rd-badge-suspicious";
    if (verdict === "SLIGHTLY SUSPICIOUS") return "rd-badge-slight";
    return "rd-badge-genuine";
  }

  function injectBadge(review, analysis) {
    const el = review.element;
    // Remove old badge if re-running
    el.querySelector(".rd-badge")?.remove();

    const badge = document.createElement("span");
    badge.className = `rd-badge ${getBadgeClass(analysis.verdict)}`;
    badge.textContent = `🕵️ ${Math.round(analysis.score * 100)}% — ${analysis.verdict}`;

    // Highlight the review container
    el.classList.remove("rd-review-highlight-fake", "rd-review-highlight-suspicious");
    if (analysis.score >= 0.50) {
      el.classList.add("rd-review-highlight-fake");
    } else if (analysis.score >= 0.35) {
      el.classList.add("rd-review-highlight-suspicious");
    }

    // Build tooltip
    const tooltip = document.createElement("div");
    tooltip.className = "rd-tooltip";

    const header = document.createElement("div");
    header.className = "rd-tooltip-header";
    header.innerHTML = `
      <span class="rd-tooltip-score" style="color:${getScoreColor(analysis.score)}">${Math.round(analysis.score * 100)}%</span>
      <span class="rd-tooltip-verdict" style="background:${getScoreColor(analysis.score)}; color:#fff">${analysis.verdict}</span>
    `;
    tooltip.appendChild(header);

    // AI assessment section (if available)
    if (analysis.aiResult) {
      const aiSection = document.createElement("div");
      aiSection.className = "rd-ai-section";
      aiSection.innerHTML = `
        <div class="rd-signal" style="padding: 6px 0; border-bottom: 1px solid #333; margin-bottom: 4px;">
          <span class="rd-signal-name" style="color: #b388ff;">🤖 AI opinion</span>
          <div class="rd-signal-bar"><div class="rd-signal-bar-fill" style="width:${analysis.aiResult.fakeProbability * 100}%; background:#7c4dff"></div></div>
          <span class="rd-signal-reason" style="color: #ce93d8;">${Math.round(analysis.aiResult.fakeProbability * 100)}% fake</span>
        </div>
        <div style="font-size: 11px; color: #b0b0b0; padding: 2px 0 6px; border-bottom: 1px solid #333; margin-bottom: 4px; font-style: italic;">
          "${analysis.aiResult.reasoning}"
        </div>
      `;
      tooltip.appendChild(aiSection);
    }

    // Heuristic signals
    const sorted = [...analysis.signals].sort((a, b) => b.score * b.weight - a.score * a.weight);
    for (const sig of sorted) {
      if (sig.score === 0) continue;
      const row = document.createElement("div");
      row.className = "rd-signal";
      const barColor = getScoreColor(sig.score);
      row.innerHTML = `
        <span class="rd-signal-name">${sig.name.replace(/_/g, " ")}</span>
        <div class="rd-signal-bar"><div class="rd-signal-bar-fill" style="width:${sig.score * 100}%; background:${barColor}"></div></div>
        <span class="rd-signal-reason">${sig.reason}</span>
      `;
      tooltip.appendChild(row);
    }

    // Score breakdown footer if AI was used
    if (analysis.aiResult) {
      const footer = document.createElement("div");
      footer.style.cssText = "font-size: 10px; color: #666; margin-top: 6px; padding-top: 6px; border-top: 1px solid #333; text-align: center;";
      footer.textContent = `Heuristic: ${Math.round(analysis.heuristicScore * 100)}% · AI: ${Math.round(analysis.aiResult.fakeProbability * 100)}% · Blended: ${Math.round(analysis.score * 100)}%`;
      tooltip.appendChild(footer);
    }

    badge.appendChild(tooltip);

    // Toggle tooltip on click
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".rd-tooltip.rd-show").forEach((t) => {
        if (t !== tooltip) t.classList.remove("rd-show");
      });
      tooltip.classList.toggle("rd-show");
    });

    const nameRow = el.querySelector('.d4r55')?.parentElement || el.firstElementChild;
    if (nameRow) {
      nameRow.style.display = "flex";
      nameRow.style.alignItems = "center";
      nameRow.style.flexWrap = "wrap";
      nameRow.appendChild(badge);
    } else {
      el.prepend(badge);
    }
  }

  // ----------------------------------------------------------
  // SUMMARY PANEL
  // ----------------------------------------------------------

  function showSummary(analyses, bizInfo, aiEnabled) {
    document.querySelector(".rd-summary-panel")?.remove();

    const total = analyses.length;
    const fakeCount = analyses.filter((a) => a.verdict.includes("FAKE")).length;
    const suspCount = analyses.filter((a) => a.verdict === "SUSPICIOUS").length;
    const genuineCount = total - fakeCount - suspCount;
    const avgScore = (analyses.reduce((s, a) => s + a.score, 0) / total) || 0;

    const aiLine = aiEnabled
      ? `<div style="margin-top: 6px; font-size: 11px; color: #b388ff; display: flex; align-items: center; gap: 4px;">🤖 AI-enhanced analysis</div>`
      : `<div style="margin-top: 6px; font-size: 11px; color: #666;">Heuristic-only mode</div>`;

    const panel = document.createElement("div");
    panel.className = "rd-summary-panel";
    panel.innerHTML = `
      <button class="rd-close-btn" title="Close">✕</button>
      <h2>🕵️ Review Detective</h2>
      <div style="margin-bottom: 8px; color: #aaa; font-size: 12px;">${bizInfo.name}</div>
      <div class="rd-summary-stat">
        <span>Reviews analyzed</span>
        <span class="rd-summary-stat-value">${total}</span>
      </div>
      <div class="rd-summary-stat">
        <span style="color:#f44336">🔴 Likely fake</span>
        <span class="rd-summary-stat-value" style="color:#f44336">${fakeCount} (${total > 0 ? Math.round(fakeCount / total * 100) : 0}%)</span>
      </div>
      <div class="rd-summary-stat">
        <span style="color:#ff9800">🟡 Suspicious</span>
        <span class="rd-summary-stat-value" style="color:#ff9800">${suspCount}</span>
      </div>
      <div class="rd-summary-stat">
        <span style="color:#4caf50">🟢 Likely genuine</span>
        <span class="rd-summary-stat-value" style="color:#4caf50">${genuineCount}</span>
      </div>
      <div class="rd-summary-stat" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #333;">
        <span>Avg fake score</span>
        <span class="rd-summary-stat-value" style="color:${getScoreColor(avgScore)}">${Math.round(avgScore * 100)}%</span>
      </div>
      ${aiLine}
      <div style="margin-top: 8px; font-size: 11px; color: #666; text-align: center;">
        Click any badge on a review for details
      </div>
    `;

    panel.querySelector(".rd-close-btn").addEventListener("click", () => panel.remove());
    document.body.appendChild(panel);
  }

  // ----------------------------------------------------------
  // PROGRESS INDICATOR
  // ----------------------------------------------------------

  function showProgress(text) {
    let el = document.querySelector(".rd-progress");
    if (!el) {
      el = document.createElement("div");
      el.className = "rd-progress";
      document.body.appendChild(el);
    }
    el.innerHTML = `<div class="rd-spinner"></div><span>${text}</span>`;
    return el;
  }

  function hideProgress() {
    document.querySelector(".rd-progress")?.remove();
  }

  // ----------------------------------------------------------
  // SCROLL TO LOAD MORE REVIEWS
  // ----------------------------------------------------------

  async function scrollToLoadReviews(maxScrolls = 15) {
    const scrollEl =
      document.querySelector('div.m6QErb.DxyBCb.kA9KIf.dS8AEf') ||
      document.querySelector('div.m6QErb.DxyBCb') ||
      document.querySelector('div[role="main"] div.m6QErb');

    if (!scrollEl) {
      console.warn("[Review Detective] Could not find scrollable review pane");
      return;
    }

    let prevCount = 0;
    let staleRounds = 0;

    for (let i = 0; i < maxScrolls; i++) {
      showProgress(`Scrolling to load reviews... (${document.querySelectorAll('[data-review-id]').length} found)`);
      scrollEl.scrollTop = scrollEl.scrollHeight;
      await sleep(1500);

      document.querySelectorAll('button.w8nwRe').forEach((btn) => btn.click());

      const currentCount = document.querySelectorAll("[data-review-id]").length;
      if (currentCount === prevCount) {
        staleRounds++;
        if (staleRounds >= 3) break;
      } else {
        staleRounds = 0;
      }
      prevCount = currentCount;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ----------------------------------------------------------
  // MAIN ORCHESTRATOR
  // ----------------------------------------------------------

  async function runAnalysis() {
    // Clean up previous run
    document.querySelectorAll(".rd-badge, .rd-summary-panel").forEach((el) => el.remove());
    document.querySelectorAll(".rd-review-highlight-fake, .rd-review-highlight-suspicious").forEach((el) => {
      el.classList.remove("rd-review-highlight-fake", "rd-review-highlight-suspicious");
    });

    showProgress("Starting analysis...");

    // Step 1: Navigate to reviews tab if needed
    const reviewsTab = document.querySelector('button[aria-label*="Reviews"]') ||
      document.querySelector('button[data-tab-id="reviews"]');
    if (reviewsTab && !reviewsTab.getAttribute("aria-selected")?.includes("true")) {
      reviewsTab.click();
      await sleep(2000);
    }

    // Step 2: Sort by newest
    const sortBtn = document.querySelector('button[aria-label="Sort reviews"]') ||
      document.querySelector('button[data-value="Sort"]');
    if (sortBtn) {
      sortBtn.click();
      await sleep(800);
      const newestOption = [...document.querySelectorAll('div[role="menuitemradio"]')]
        .find((el) => el.textContent?.toLowerCase().includes("newest"));
      if (newestOption) {
        newestOption.click();
        await sleep(2000);
      } else {
        document.body.click();
        await sleep(300);
      }
    }

    // Step 3: Scroll to load reviews
    await scrollToLoadReviews(20);

    // Step 4: Expand all "More" buttons
    showProgress("Expanding review text...");
    document.querySelectorAll("button.w8nwRe").forEach((btn) => btn.click());
    await sleep(500);

    // Step 5: Scrape
    showProgress("Scraping review data...");
    const bizInfo = getBusinessInfo();
    const reviews = scrapeReviews();

    if (reviews.length === 0) {
      hideProgress();
      alert("Review Detective: No reviews found on this page. Make sure you're on a Google Maps business page with reviews.");
      return;
    }

    showProgress(`Analyzing ${reviews.length} reviews...`);

    // Step 6: Heuristic analysis
    const ctx = { avgRating: bizInfo.avgRating, allReviews: reviews };
    const analyses = reviews.map((review) => {
      const { signals, heuristicScore } = analyzeReview(review, ctx);
      return {
        review,
        signals,
        heuristicScore,
        aiResult: null,       // filled later if AI is enabled
        score: heuristicScore, // final blended score
        verdict: computeVerdict(heuristicScore),
      };
    });

    // Step 7: Optional AI analysis
    const aiSettings = await getAISettings();
    let aiEnabled = false;

    if (aiSettings.apiKey) {
      // Filter to reviews above the threshold
      const candidates = analyses.filter((a) => a.heuristicScore >= aiSettings.threshold);

      if (candidates.length > 0) {
        showProgress(`🤖 AI analyzing ${candidates.length} suspicious review(s)...`);
        aiEnabled = true;

        try {
          const aiResults = await llmAnalyzeBatch(candidates, bizInfo, aiSettings.apiKey, aiSettings.model);

          // Merge AI results back
          for (let i = 0; i < candidates.length; i++) {
            const aiResult = aiResults[i];
            if (aiResult) {
              candidates[i].aiResult = aiResult;
              // Blend: 60% heuristic, 40% AI
              candidates[i].score =
                0.6 * candidates[i].heuristicScore +
                0.4 * aiResult.fakeProbability;
              candidates[i].verdict = computeVerdict(candidates[i].score);
            }
            // If aiResult is null (failed), score stays as heuristic-only — graceful fallback
          }
        } catch (e) {
          console.warn("[Review Detective] AI analysis failed, using heuristics only:", e.message);
          // All reviews keep their heuristic-only scores — graceful fallback
        }
      }
    }

    // Step 8: Inject badges
    showProgress("Annotating reviews...");
    for (const analysis of analyses) {
      injectBadge(analysis.review, analysis);
    }

    // Step 9: Show summary
    hideProgress();
    showSummary(analyses, bizInfo, aiEnabled);

    console.log("[Review Detective] Analysis complete:", {
      total: analyses.length,
      aiEnabled,
      aiAnalyzed: analyses.filter((a) => a.aiResult).length,
      fake: analyses.filter((a) => a.verdict.includes("FAKE")).length,
      suspicious: analyses.filter((a) => a.verdict === "SUSPICIOUS").length,
    });
  }

  // ----------------------------------------------------------
  // CLOSE TOOLTIPS ON OUTSIDE CLICK
  // ----------------------------------------------------------
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".rd-badge")) {
      document.querySelectorAll(".rd-tooltip.rd-show").forEach((t) => t.classList.remove("rd-show"));
    }
  });

  // ----------------------------------------------------------
  // MESSAGE LISTENER (from popup)
  // ----------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "analyze") {
      runAnalysis().then(() => sendResponse({ ok: true })).catch((e) => {
        console.error("[Review Detective]", e);
        sendResponse({ ok: false, error: e.message });
      });
      return true; // async response
    }
  });
})();
