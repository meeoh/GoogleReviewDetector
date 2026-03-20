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
    // Business name — try multiple selectors used across Google Maps layouts
    const nameEl =
      document.querySelector('h1.DUwDvf') ||
      document.querySelector('h1.fontHeadlineLarge') ||
      document.querySelector('[data-attrid="title"]') ||
      document.querySelector('div[role="main"] h1') ||
      document.querySelector('h1');
    let name = nameEl?.textContent?.trim() || "";

    // Fallback: try to extract from page title ("Business Name - Google Maps")
    if (!name) {
      const titleMatch = document.title.match(/^(.+?)\s*[-–—]\s*Google/i);
      name = titleMatch ? titleMatch[1].trim() : "Unknown Business";
    }

    // Average rating — try multiple selectors
    const ratingEl =
      document.querySelector('div.F7nice span[aria-hidden="true"]') ||
      document.querySelector('span.ceNzKf') ||
      document.querySelector('div.fontDisplayLarge') ||
      document.querySelector('span[role="img"][aria-label*="star"]');
    let avgRating = null;
    if (ratingEl) {
      const ratingText = ratingEl.getAttribute("aria-label") || ratingEl.textContent || "";
      const match = ratingText.match(/([\d.]+)/);
      if (match) avgRating = parseFloat(match[1]);
    }

    // Total review count
    let totalReviews = null;
    const reviewCountEl =
      document.querySelector('span[aria-label*="reviews"]') ||
      document.querySelector('span[aria-label*="review"]');
    if (reviewCountEl) {
      const match = (reviewCountEl.getAttribute("aria-label") || reviewCountEl.textContent || "").match(/([\d,]+)/);
      if (match) totalReviews = parseInt(match[1].replace(/,/g, ""));
    }
    // Fallback: look for "(X)" pattern near the rating
    if (!totalReviews) {
      const parentText = ratingEl?.closest?.("div")?.parentElement?.textContent || "";
      const match = parentText.match(/\(([\d,]+)\)/);
      if (match) totalReviews = parseInt(match[1].replace(/,/g, ""));
    }

    return { name, avgRating, totalReviews };
  }

  function scrapeReviews() {
    // Use the top-level review container (jftiEf) to avoid duplicates —
    // Google Maps nests the same data-review-id on multiple child elements
    const reviewEls = document.querySelectorAll('div.jftiEf[data-review-id]');
    const seen = new Set();
    const reviews = [];

    for (const el of reviewEls) {
      try {
        const reviewId = el.getAttribute("data-review-id");
        if (seen.has(reviewId)) continue;
        seen.add(reviewId);

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
    const BATCH_SIZE = 100;
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
    el.querySelectorAll(".rd-badge").forEach((b) => b.remove());

    const badge = document.createElement("span");
    badge.className = `rd-badge ${getBadgeClass(analysis.verdict)}`;
    // Get the top reason(s) to display on the badge
    const topReasons = analysis.signals
      .filter((s) => s.score > 0)
      .sort((a, b) => (b.score * b.weight) - (a.score * a.weight))
      .slice(0, 2)
      .map((s) => s.reason);
    const reasonText = topReasons.length > 0 ? topReasons.join(" · ") : "";

    badge.innerHTML = `
      <span>🕵️ ${Math.round(analysis.score * 100)}% — ${analysis.verdict}</span>
      ${reasonText && analysis.score >= 0.20 ? `<span class="rd-badge-reason">${reasonText}</span>` : ""}
    `;

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

    // Toggle tooltip on click — position it fixed near the badge
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".rd-tooltip.rd-show").forEach((t) => {
        if (t !== tooltip) t.classList.remove("rd-show");
      });

      if (!tooltip.classList.contains("rd-show")) {
        // Position the tooltip near the badge
        const rect = badge.getBoundingClientRect();
        let top = rect.bottom + 6;
        let left = rect.left;

        // Keep within viewport
        if (left + 340 > window.innerWidth) left = window.innerWidth - 350;
        if (left < 10) left = 10;
        if (top + 300 > window.innerHeight) top = rect.top - 310;
        if (top < 10) top = 10;

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
      }

      tooltip.classList.toggle("rd-show");
    });

    // Insert badge below the reviewer info section, above the review content.
    // Target the star rating row as an anchor point — badge goes right before it.
    const starRow = el.querySelector('span.kvMYJc')?.closest('.DU9Pgb') ||
                    el.querySelector('span.kvMYJc')?.parentElement;
    if (starRow) {
      starRow.insertAdjacentElement("beforebegin", badge);
    } else {
      // Fallback: insert after the reviewer name
      const nameEl = el.querySelector('.d4r55');
      if (nameEl) {
        // Go up to the header container and insert after it
        const headerContainer = nameEl.closest('.jJc9Ad') || nameEl.parentElement?.parentElement;
        if (headerContainer) {
          headerContainer.insertAdjacentElement("afterend", badge);
        } else {
          nameEl.insertAdjacentElement("afterend", badge);
        }
      } else {
        el.insertAdjacentElement("afterbegin", badge);
      }
    }
  }

  // ----------------------------------------------------------
  // SUMMARY PANEL
  // ----------------------------------------------------------

  function showSummary(analyses, bizInfo, aiEnabled) {
    document.querySelector(".rd-summary-panel")?.remove();

    const total = analyses.length;
    const veryFakeCount = analyses.filter((a) => a.verdict === "VERY LIKELY FAKE").length;
    const likelyFakeCount = analyses.filter((a) => a.verdict === "LIKELY FAKE").length;
    const fakeCount = veryFakeCount + likelyFakeCount;
    const suspCount = analyses.filter((a) => a.verdict === "SUSPICIOUS").length;
    const slightCount = analyses.filter((a) => a.verdict === "SLIGHTLY SUSPICIOUS").length;
    const genuineCount = analyses.filter((a) => a.verdict === "LIKELY GENUINE").length;
    const avgScore = (analyses.reduce((s, a) => s + a.score, 0) / total) || 0;
    const maxScore = Math.max(...analyses.map((a) => a.score));

    // Rating distribution
    const ratingCounts = [0, 0, 0, 0, 0];
    for (const a of analyses) {
      if (a.review.rating >= 1 && a.review.rating <= 5) ratingCounts[a.review.rating - 1]++;
    }

    // Top triggered signals across all reviews
    const signalHits = {};
    for (const a of analyses) {
      for (const s of a.signals) {
        if (s.score > 0) {
          signalHits[s.name] = (signalHits[s.name] || 0) + 1;
        }
      }
    }
    const topSignals = Object.entries(signalHits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const aiLine = aiEnabled
      ? `<div style="font-size: 11px; color: #b388ff; display: flex; align-items: center; gap: 4px;">🤖 AI-enhanced analysis</div>`
      : `<div style="font-size: 11px; color: #666;">Heuristic-only mode</div>`;

    // Build rating bar chart
    const maxRating = Math.max(...ratingCounts, 1);
    const ratingBars = ratingCounts.map((count, i) => {
      const pct = Math.round((count / maxRating) * 100);
      const stars = i + 1;
      return `<div style="display:flex; align-items:center; gap:6px; font-size:11px;">
        <span style="width:14px; color:#aaa;">${stars}★</span>
        <div style="flex:1; height:6px; background:#222; border-radius:3px; overflow:hidden;">
          <div style="width:${pct}%; height:100%; background:${stars >= 4 ? '#4caf50' : stars >= 3 ? '#ffeb3b' : '#f44336'}; border-radius:3px;"></div>
        </div>
        <span style="width:28px; text-align:right; color:#888;">${count}</span>
      </div>`;
    }).reverse().join("");

    // Build top signals list
    const signalsList = topSignals.map(([name, count]) => {
      const pct = Math.round((count / total) * 100);
      return `<div style="display:flex; justify-content:space-between; font-size:11px; padding:1px 0;">
        <span style="color:#aaa;">${name.replace(/_/g, " ")}</span>
        <span style="color:#e94560;">${count} (${pct}%)</span>
      </div>`;
    }).join("");

    // Flagged reviews — sorted by score, only non-genuine
    const flagged = analyses
      .filter((a) => a.score >= 0.20)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    const panel = document.createElement("div");
    panel.className = "rd-summary-panel";
    panel.innerHTML = `
      <button class="rd-close-btn" title="Close">✕</button>
      <h2>🕵️ Review Detective</h2>
      <div style="margin-bottom: 10px; color: #ccc; font-size: 13px; font-weight: 600;">${bizInfo.name}</div>
      <div style="display:flex; gap:12px; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #333;">
        <div style="text-align:center; flex:1;">
          <div style="font-size:22px; font-weight:800; color:#fff;">${total}</div>
          <div style="font-size:10px; color:#888;">analyzed</div>
        </div>
        <div style="text-align:center; flex:1;">
          <div style="font-size:22px; font-weight:800; color:${bizInfo.avgRating ? '#fff' : '#555'};">${bizInfo.avgRating ? bizInfo.avgRating.toFixed(1) + '★' : 'N/A'}</div>
          <div style="font-size:10px; color:#888;">avg rating</div>
        </div>
        <div style="text-align:center; flex:1;">
          <div style="font-size:22px; font-weight:800; color:${getScoreColor(avgScore)}">${Math.round(avgScore * 100)}%</div>
          <div style="font-size:10px; color:#888;">avg fake</div>
        </div>
      </div>

      <div style="margin-bottom:10px;">
        <div style="font-size:11px; font-weight:600; color:#888; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">Verdict Breakdown</div>
        ${veryFakeCount > 0 ? `<div class="rd-summary-stat"><span style="color:#d32f2f">🔴 Very likely fake</span><span class="rd-summary-stat-value" style="color:#d32f2f">${veryFakeCount}</span></div>` : ''}
        ${likelyFakeCount > 0 ? `<div class="rd-summary-stat"><span style="color:#f44336">🔴 Likely fake</span><span class="rd-summary-stat-value" style="color:#f44336">${likelyFakeCount}</span></div>` : ''}
        ${suspCount > 0 ? `<div class="rd-summary-stat"><span style="color:#ff9800">🟡 Suspicious</span><span class="rd-summary-stat-value" style="color:#ff9800">${suspCount}</span></div>` : ''}
        ${slightCount > 0 ? `<div class="rd-summary-stat"><span style="color:#ffeb3b">🟡 Slightly suspicious</span><span class="rd-summary-stat-value" style="color:#ffeb3b">${slightCount}</span></div>` : ''}
        <div class="rd-summary-stat"><span style="color:#4caf50">🟢 Likely genuine</span><span class="rd-summary-stat-value" style="color:#4caf50">${genuineCount}</span></div>
      </div>

      <div style="margin-bottom:10px; padding-top:8px; border-top:1px solid #333;">
        <div style="font-size:11px; font-weight:600; color:#888; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">Rating Distribution</div>
        <div style="display:flex; flex-direction:column; gap:3px;">
          ${ratingBars}
        </div>
      </div>

      ${topSignals.length > 0 ? `
      <div style="margin-bottom:10px; padding-top:8px; border-top:1px solid #333;">
        <div style="font-size:11px; font-weight:600; color:#888; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">Top Triggered Signals</div>
        ${signalsList}
      </div>
      ` : ''}

      <div style="display:flex; justify-content:space-between; padding-top:8px; border-top:1px solid #333; font-size:11px;">
        <span style="color:#888;">Highest fake score</span>
        <span style="font-weight:700; color:${getScoreColor(maxScore)}">${Math.round(maxScore * 100)}%</span>
      </div>

      ${flagged.length > 0 ? `
      <div style="margin-top:10px; padding-top:8px; border-top:1px solid #333;">
        <div style="font-size:11px; font-weight:600; color:#888; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">🚩 Flagged Reviews (top ${flagged.length})</div>
        <div class="rd-flagged-list" style="max-height:200px; overflow-y:auto;"></div>
      </div>
      ` : ''}

      <div style="margin-top:10px; padding-top:8px; border-top:1px solid #333;">
        ${aiLine}
      </div>
    `;

    panel.querySelector(".rd-close-btn").addEventListener("click", () => panel.remove());

    // Build clickable flagged review list
    const listContainer = panel.querySelector(".rd-flagged-list");
    if (listContainer && flagged.length > 0) {
      for (const a of flagged) {
        const row = document.createElement("div");
        row.className = "rd-flagged-row";
        row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 4px; border-radius:6px; cursor:pointer; transition:background 0.15s; font-size:11px;";

        const scoreColor = getScoreColor(a.score);
        const textPreview = a.review.text
          ? (a.review.text.length > 50 ? a.review.text.slice(0, 50) + "…" : a.review.text)
          : "(no text)";

        row.innerHTML = `
          <span style="font-weight:800; color:${scoreColor}; min-width:32px;">${Math.round(a.score * 100)}%</span>
          <span style="color:#fff; font-weight:600; min-width:60px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${a.review.reviewerName}</span>
          <span style="color:#888; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${textPreview}</span>
          <span style="color:#555;">→</span>
        `;

        row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,0.05)"; });
        row.addEventListener("mouseleave", () => { row.style.background = "none"; });
        row.addEventListener("click", () => {
          a.review.element.scrollIntoView({ behavior: "smooth", block: "center" });
          // Flash highlight
          a.review.element.style.transition = "outline 0.2s";
          a.review.element.style.outline = `2px solid ${scoreColor}`;
          a.review.element.style.outlineOffset = "4px";
          setTimeout(() => {
            a.review.element.style.outline = "none";
          }, 2000);
        });

        listContainer.appendChild(row);
      }
    }

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
