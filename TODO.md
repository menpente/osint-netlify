# TODO

## Search Quality
- [x] Switch from Brave Search API to Google Custom Search API
  - Better indexing of LinkedIn and social profiles
  - Confirmed: Brave misses results that Google returns as #1 (e.g. "Victor Martinez Gascón")
  - Needs: `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` env vars
  - Replace `braveSearch()` in `netlify/functions/enrich.js`

## Error Handling
- [x] Defensive JSON parsing for LLM responses
  - LLM occasionally returns non-JSON (markdown, explanation text, truncated output)
  - `JSON.parse(clean)` in `netlify/functions/enrich.js` line ~182 throws → 500
  - Add regex extraction fallback to pull JSON object out of any surrounding text
