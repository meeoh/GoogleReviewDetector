# 🕵️ Review Detective

A Chrome extension that detects fake and bot reviews on Google Maps business listings.

## How It Works

Navigate to any business on Google Maps, click the extension icon, and hit **"Analyze Reviews"**. The extension will:

1. **Auto-scroll** through the reviews panel to load as many reviews as possible
2. **Scrape** all review data directly from the page (reviewer name, rating, text, reviewer stats, dates, etc.)
3. **Run 8 detection signals** against each review to compute a fake probability score
4. **(Optional) Send suspicious reviews to an AI** for a second opinion — catches subtle fakes that heuristics miss
5. **Annotate** each review with a color-coded badge showing the verdict
6. **Show a summary panel** with overall statistics

Click any badge to see the detailed signal breakdown (and AI reasoning, if enabled).

## Detection Signals

| Signal | Weight | What It Checks |
|--------|--------|----------------|
| `duplicate_text` | 3.0× | Near-identical text across multiple reviews |
| `low_review_count` | 2.0× | Reviewer has very few total reviews (throwaway account) |
| `review_burst` | 2.0× | Many reviews posted in the same time window (coordinated attack) |
| `short_text` | 1.5× | Empty or extremely short review text |
| `generic_text` | 1.5× | Vague/templated phrases like "Great!" or "Excellent!" |
| `suspicious_name` | 1.2× | Placeholder or suspiciously short reviewer names |
| `paid_keywords` | 1.0× | Phrases commonly found in paid/incentivized reviews |
| `rating_vs_average` | 1.0× | Rating deviates significantly from business average |

## AI Analysis (Optional)

When you provide an OpenAI API key in the extension settings, reviews that score above a configurable threshold are sent to an LLM for deeper analysis. The AI evaluates:

- **Unnatural phrasing** — text that reads like ChatGPT or a template
- **Promotional language** — review reads like marketing copy
- **Suspiciously detailed** — hits every SEO keyword for the business
- **Sentiment mismatch** — glowing text but low rating, or vice versa
- **Astroturfing patterns** — competitor attacks or paid promotion

The final score is a blend of **60% heuristic + 40% AI**. If the AI fails (network error, rate limit, bad key), each review gracefully falls back to its heuristic-only score — nothing breaks.

### Setting up AI

1. Click the ⚙️ icon in the extension popup (or right-click the extension → Options)
2. Paste your OpenAI API key
3. Click **Test Key** to verify it works
4. Choose a model and threshold
5. That's it — next analysis will use AI automatically

## Verdicts

| Score | Verdict | Badge Color |
|-------|---------|-------------|
| ≥ 70% | VERY LIKELY FAKE | 🔴 Red |
| ≥ 50% | LIKELY FAKE | 🔴 Light Red |
| ≥ 35% | SUSPICIOUS | 🟡 Orange |
| ≥ 20% | SLIGHTLY SUSPICIOUS | 🟡 Yellow |
| < 20% | LIKELY GENUINE | 🟢 Green |

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **"Developer mode"** (toggle in top right)
4. Click **"Load unpacked"**
5. Select the `review-detective` folder
6. Navigate to any Google Maps business page and click the extension icon!

## Privacy

- **Heuristic analysis runs 100% locally** in your browser
- **AI analysis (opt-in)** sends review text and reviewer metadata to OpenAI's API — only for reviews above your configured threshold
- No data is sent to any other server. Your API key is stored locally in Chrome's extension storage.

## Project Structure

```
review-detective/
├── manifest.json     # Chrome extension manifest (MV3)
├── content.js        # Main logic — scraping, signals, AI integration, UI
├── content.css       # Styles for badges, tooltips, summary panel
├── popup.html        # Extension popup UI
├── popup.js          # Popup logic + AI status display
├── options.html      # Settings page (API key, model, threshold)
├── options.js        # Settings logic
├── icons/            # Extension icons
└── README.md
```

## Limitations

- Google Maps only shows a limited number of reviews in the DOM (typically up to ~200 with scrolling). The extension analyzes what's loaded.
- Relative date strings ("2 weeks ago") are used for burst detection since exact timestamps aren't in the DOM.
- This is heuristic-based detection — it flags suspicious patterns but can't guarantee a review is definitively fake or genuine.
- AI analysis costs money per API call (typically a few cents per analysis run with GPT-4o Mini).

## License

MIT
