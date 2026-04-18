# Search API Setup (Serper.dev)

Google Programmable Search Engine no longer allows searching the entire web for
new accounts (deprecated January 2026). We use **Serper.dev** instead — it
returns real Google results and has a generous free tier.

## 1. Get `SERPER_API_KEY`

1. Go to [serper.dev](https://serper.dev) and sign up
2. On the dashboard, copy your **API Key**
3. Free tier: **2,500 queries** (no credit card required)

---

## 2. Add to Netlify

1. Go to your site in [app.netlify.com](https://app.netlify.com)
2. **Site configuration → Environment variables → Add a variable**
3. Add both:

| Key | Value |
|-----|-------|
| `GROQ_API_KEY` | your Groq key from [console.groq.com](https://console.groq.com) |
| `SERPER_API_KEY` | your Serper key from step 1 |

4. Redeploy the site for the vars to take effect.

---

## 3. Local development

Copy `.env.example` to `.env.local` and fill in your keys:

```
cp .env.example .env.local
```

`netlify dev` will pick up `.env.local` automatically.

---

## Free tier limits

- Serper.dev: 2,500 queries/month free, then pay-as-you-go
- Groq: generous free tier with rate limits
