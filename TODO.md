# TODO — Future Improvements

## Reviewer History Analysis

**Priority:** High — would significantly improve detection accuracy

Currently the AI and heuristic signals only evaluate each review in isolation. We don't look at the reviewer's full posting history, which is one of the strongest fake-detection signals.

### What we're missing

- A reviewer who posted 15 five-star reviews across businesses in different cities on the same day
- Reviewers who only ever leave 5★ or 1★ reviews (no nuance)
- Reviewers whose review history is entirely one business category (e.g. all dentists — likely a paid review ring)
- Accounts that went dormant for years then suddenly posted a burst of reviews
- Reviewers who leave near-identical text across multiple businesses

### Implementation options

**Option A: Scrape reviewer profiles from Google Maps DOM**
- Click into each suspicious reviewer's Google Maps profile
- Scrape their full review history (businesses, ratings, dates, text)
- Feed this context to both the heuristic engine and the AI
- Pros: No external dependencies, free
- Cons: Slow (requires navigation per reviewer), fragile if Google changes DOM structure, may hit rate limits

**Option B: Use an external API (Outscraper, SerpAPI, etc.)**
- Call an API to pull reviewer profiles in the background
- Pros: Fast, reliable, structured data
- Cons: Requires another API key, costs money per lookup

### New signals this would unlock

| Signal | What it catches |
|--------|----------------|
| `review_velocity` | Reviewer posted many reviews in a short time span |
| `geographic_spread` | Reviews span cities/countries that a real person wouldn't visit |
| `category_concentration` | All reviews in one business category (review farm pattern) |
| `text_reuse_cross_biz` | Same/similar text left on multiple businesses |
| `rating_distribution` | Reviewer only ever gives 5★ or 1★ |
| `account_dormancy` | Account inactive for a long time then suddenly active |

### AI enhancement

If we have the reviewer's history, we can include it in the LLM prompt:

```
This reviewer has posted 23 reviews in the last 30 days:
- 22 are 5★ reviews for restaurants in 4 different states
- All reviews are 1-2 sentences
- 18 of them contain the phrase "highly recommend"
```

This context would make the AI dramatically more accurate at catching coordinated fake review campaigns.
