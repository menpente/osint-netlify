// netlify/functions/enrich.js
// Serverless function: receives {name, email}, runs Groq with web_search tool,
// returns enriched demographic JSON.

const GROQ_API_URL  = "https://api.groq.com/openai/v1/chat/completions";
const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const MODEL         = "llama-3.3-70b-versatile";
const MAX_TOOL_ROUNDS = 4;   // max search rounds before forcing final answer

const SYSTEM_PROMPT = `You are an OSINT demographic enrichment engine. Given a person's name and/or email, your job is to find their PUBLIC professional profile and return structured demographic tags.

PROCESS:
1. Build targeted search queries using the name and/or email handle provided.
   - If both name and email: search by full name first, then try the email local part as a username.
   - If name only: search LinkedIn, GitHub, Twitter/X by full name.
   - If email only: use the local part (before @) as a potential username handle.
2. Use the web_search tool to run those queries (2-4 searches max).
3. From ONLY publicly available results, infer demographic tags.

ETHICAL RULES (non-negotiable):
- Only use publicly visible profile data.
- Never infer: religion, health conditions, sexual orientation, politics, family status.
- Return category labels only — never raw scraped text.

FINAL OUTPUT — return a single valid JSON object, no markdown fences, no explanation:
{
  "resolved_name":    string or null,
  "industry":         "legal"|"tech"|"education"|"translation"|"healthcare"|"finance"|"marketing"|"freelance"|"other" or null,
  "role":             "junior"|"mid"|"senior"|"lead"|"manager"|"executive"|"freelancer"|"student"|"unknown" or null,
  "country":          string or null,
  "education_level":  "bachelor"|"master"|"phd"|"bootcamp"|"self-taught"|"technical"|"unknown" or null,
  "interests":        array of up to 5 from ["ai","data-science","legal-writing","translation","education-tech","writing","devops","design","finance","open-source"] or [],
  "confidence":       float 0.0-1.0,
  "sources":          array of platform names e.g. ["linkedin","github"],
  "match_notes":      one-sentence summary of what was found or "No public profile found"
}`;

// ── Brave Search ──────────────────────────────────────────────────────────────
async function braveSearch(query, apiKey) {
  const url = `${BRAVE_API_URL}?q=${encodeURIComponent(query)}&count=5&search_lang=en`;
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });
  if (!res.ok) throw new Error(`Brave Search error ${res.status}`);
  const data = await res.json();

  // Return a compact digest so it fits in the context window
  const results = (data.web?.results || []).slice(0, 5).map(r => ({
    title:       r.title,
    url:         r.url,
    description: r.description?.slice(0, 300),
  }));
  return JSON.stringify(results);
}

// ── Groq agentic loop ─────────────────────────────────────────────────────────
async function runGroqLoop(name, email, groqKey, braveKey) {
  const userContent = [
    name  && `Full name: ${name}`,
    email && `Email: ${email}`,
  ].filter(Boolean).join("\n");

  const messages = [
    { role: "system",  content: SYSTEM_PROMPT },
    { role: "user",    content: `Enrich this contact:\n${userContent}` },
  ];

  const tools = [{
    type: "function",
    function: {
      name:        "web_search",
      description: "Search the public web for profile information about a person.",
      parameters: {
        type:       "object",
        properties: { query: { type: "string", description: "Search query string" } },
        required:   ["query"],
      },
    },
  }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(GROQ_API_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
      body: JSON.stringify({
        model:       MODEL,
        messages,
        tools,
        tool_choice: round < MAX_TOOL_ROUNDS - 1 ? "auto" : "none",
        temperature: 0.1,
        max_tokens:  1024,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Groq error ${res.status}: ${err}`);
    }

    const data    = await res.json();
    const message = data.choices[0].message;
    messages.push(message);

    // No tool calls → final answer
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content;
    }

    // Execute each tool call
    for (const call of message.tool_calls) {
      const { query } = JSON.parse(call.function.arguments);
      let searchResult;
      try {
        searchResult = await braveSearch(query, braveKey);
      } catch (e) {
        searchResult = JSON.stringify({ error: e.message });
      }
      messages.push({
        role:         "tool",
        tool_call_id: call.id,
        content:      searchResult,
      });
    }
  }

  // Fallback: force a final text answer
  const finalRes = await fetch(GROQ_API_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: MODEL, messages,
      tool_choice: "none", temperature: 0.1, max_tokens: 512,
    }),
  });
  const finalData = await finalRes.json();
  return finalData.choices[0].message.content;
}

// ── Netlify handler ───────────────────────────────────────────────────────────
export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const groqKey  = process.env.GROQ_API_KEY;
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;

  if (!groqKey)  return { statusCode: 500, body: JSON.stringify({ error: "GROQ_API_KEY not set" }) };
  if (!braveKey) return { statusCode: 500, body: JSON.stringify({ error: "BRAVE_SEARCH_API_KEY not set" }) };

  let name, email;
  try {
    ({ name, email } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!name && !email) {
    return { statusCode: 400, body: JSON.stringify({ error: "Provide at least name or email" }) };
  }

  try {
    const raw = await runGroqLoop(name, email, groqKey, braveKey);
    // Strip any accidental markdown fences
    const clean = raw.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const result = JSON.parse(clean);
    return {
      statusCode: 200,
      headers: {
        "Content-Type":                "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ name, email, ...result }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        name, email,
        error:        err.message,
        match_notes:  "Enrichment failed",
        confidence:   0,
        sources:      [],
        interests:    [],
      }),
    };
  }
};
