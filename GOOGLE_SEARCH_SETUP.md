# Google Custom Search API Setup

## 1. Get `GOOGLE_API_KEY`

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. In the left menu go to **APIs & Services → Library**
4. Search for **"Custom Search API"** and click **Enable**
5. Go to **APIs & Services → Credentials**
6. Click **+ Create Credentials → API key**
7. Copy the key — that is your `GOOGLE_API_KEY`

> Optional: click **Restrict Key** and limit it to the Custom Search API only.

---

## 2. Get `GOOGLE_CSE_ID`

1. Go to [programmablesearchengine.google.com](https://programmablesearchengine.google.com)
2. Click **Add** (or **Get started**)
3. Under **Sites to search** select **"Search the entire web"**
4. Give it any name (e.g. "OSINT Enrichment")
5. Click **Create**
6. On the next screen click **Customize** → go to **Setup**
7. Copy the **Search engine ID** — that is your `GOOGLE_CSE_ID`

---

## 3. Add to Netlify

1. Go to your site in [app.netlify.com](https://app.netlify.com)
2. **Site configuration → Environment variables → Add a variable**
3. Add both:

| Key | Value |
|-----|-------|
| `GOOGLE_API_KEY` | the API key from step 1 |
| `GOOGLE_CSE_ID` | the search engine ID from step 2 |

4. Redeploy the site (or trigger a new deploy) for the vars to take effect.

---

## Free tier limits

- 100 queries/day free
- $5 per 1,000 queries beyond that (max 10,000/day)
