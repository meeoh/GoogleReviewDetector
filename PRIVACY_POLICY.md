# Privacy Policy — Review Detective

**Last updated:** March 25, 2026

Review Detective is a Chrome extension that analyzes Google Maps reviews for signs of fake or bot-generated content. This privacy policy explains what data the extension accesses, how it is used, and how it is stored.

## Data the Extension Accesses

### Google Maps Page Content
When you activate the extension on a Google Maps business page, it reads review data directly from the page DOM, including reviewer names, review text, ratings, dates, and reviewer statistics. **This data is processed entirely in your browser** and is never sent to any server owned or operated by us.

### OpenAI API Key (Optional)
If you choose to enable AI-enhanced analysis, you provide your own OpenAI API key. This key is stored locally in your browser using `chrome.storage.local` and is **never transmitted to us or any third party** other than OpenAI when making API requests.

### User Preferences
Your settings (selected AI model, analysis threshold) are stored locally in your browser using `chrome.storage.local`.

## Third-Party Data Sharing

### OpenAI (Optional)
If you enable AI-enhanced analysis by providing an OpenAI API key, the extension sends review data (reviewer names, review text, ratings, dates, and related metadata) to the [OpenAI API](https://openai.com/policies/privacy-policy) for analysis. This only happens when you explicitly trigger an analysis. **If you do not provide an API key, no data is sent to any external service.**

### No Other Third Parties
We do not sell, share, or transmit any data to any other third parties. We do not operate any servers or backend services. We do not collect analytics or telemetry.

## Data Storage

All data (API key, preferences) is stored locally on your device via `chrome.storage.local`. No data is stored remotely. You can delete your stored API key at any time from the extension's settings page.

## Data Collection

**We collect no data whatsoever.** The extension operates entirely client-side. We have no servers, no databases, and no way to access any of your data.

## Permissions Used

| Permission | Purpose |
|---|---|
| `activeTab` | Read Google Maps page content when you activate the extension |
| `storage` | Save your preferences and API key locally |
| `host_permissions` (api.openai.com) | Send review data to OpenAI for AI analysis (only if you provide an API key) |

## Changes to This Policy

If this policy is updated, the changes will be reflected in this document with an updated date.

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/meeoh/GoogleReviewDetector/issues).
