// netlify/functions/enrich.js
// Serverless function: receives {name, email}, runs Groq with web_search tool,
// returns enriched demographic JSON.

const GROQ_API_URL  = "https://api.groq.com/openai/v1/chat/completions";
const GOOGLE_CSE_URL = "https://www.googleapis.com/customsearch/v1";
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
  "profile_urls":     array of direct profile URLs in the same order as "sources" e.g. ["https://linkedin.com/in/johndoe","https://github.com/johndoe"] — use the exact URLs returned by web_search, empty array if none found,
  "match_notes":      one-sentence summary of what was found or "No public profile found"
}`;

// ── Google Custom Search ──────────────────────────────────────────────────────
async function googleSearch(query, apiKey, cseId) {
  const url = `${GOOGLE_CSE_URL}?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(query)}&num=5`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Google Search error ${res.status}`);
  const data = await res.json();

  // Return a compact digest so it fits in the context window
  const results = (data.items || []).slice(0, 5).map(r => ({
    title:       r.title,
    url:         r.link,
    description: r.snippet?.slice(0, 300),
  }));
  return JSON.stringify(results);
}

// ── Groq agentic loop ─────────────────────────────────────────────────────────
async function runGroqLoop(name, email, groqKey, googleKey, googleCse, networks) {
  const userContent = [
    name  && `Full name: ${name}`,
    email && `Email: ${email}`,
  ].filter(Boolean).join("\n");

  const networkRestriction = networks && networks.length > 0
    ? `\n\nRESTRICTION: Only search on these platforms: ${networks.join(", ")}. Do not use other social networks.`
    : "";

  const messages = [
    { role: "system",  content: SYSTEM_PROMPT + networkRestriction },
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
        searchResult = await googleSearch(query, googleKey, googleCse);
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

  const groqKey   = process.env.GROQ_API_KEY;
  const googleKey = process.env.GOOGLE_API_KEY;
  const googleCse = process.env.GOOGLE_CSE_ID;

  if (!groqKey)   return { statusCode: 500, body: JSON.stringify({ error: "GROQ_API_KEY not set" }) };
  if (!googleKey) return { statusCode: 500, body: JSON.stringify({ error: "GOOGLE_API_KEY not set" }) };
  if (!googleCse) return { statusCode: 500, body: JSON.stringify({ error: "GOOGLE_CSE_ID not set" }) };

  let name, email, networks;
  try {
    ({ name, email, networks } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!name && !email) {
    return { statusCode: 400, body: JSON.stringify({ error: "Provide at least name or email" }) };
  }

  try {
    const raw = await runGroqLoop(name, email, groqKey, googleKey, googleCse, networks);
    // Strip markdown fences, then fall back to extracting first {...} block
    let clean = raw.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    if (!clean.startsWith("{")) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) clean = match[0];
    }
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
