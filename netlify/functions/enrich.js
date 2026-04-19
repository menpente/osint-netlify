// netlify/functions/enrich.js
// Serverless function: receives {name, email}, runs Groq with web_search tool,
// returns enriched demographic JSON.

const GROQ_API_URL   = "https://api.groq.com/openai/v1/chat/completions";
const SERPER_API_URL = "https://google.serper.dev/search";
const MODEL          = "llama-3.3-70b-versatile";
const MAX_TOOL_ROUNDS = 4;   // max search rounds before forcing final answer

// Generic email providers — never infer company from these domains
const GENERIC_DOMAINS = new Set([
  "gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com",
  "protonmail.com","live.com","me.com","aol.com","mail.com",
  "gmx.com","zoho.com","yandex.com","tutanota.com","yahoo.es",
  "hotmail.es","msn.com","googlemail.com",
]);

// ── Company inference from email domain ───────────────────────────────────────
function inferCompany(email) {
  if (!email?.includes("@")) return null;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain || GENERIC_DOMAINS.has(domain)) return null;
  return domain;
}

// ── Serper.dev Search — raw (returns parsed objects) ─────────────────────────
async function serperSearchRaw(query, apiKey, { gl, hl, num = 5 } = {}) {
  const body = { q: query, num };
  if (gl) body.gl = gl;
  if (hl) body.hl = hl;

  const res = await fetch(SERPER_API_URL, {
    method:  "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Serper error ${res.status}`);
  const data = await res.json();
  return (data.organic || []).slice(0, num).map(r => ({
    url:         r.link?.split("?")[0] || "",
    title:       r.title  || "",
    description: r.snippet || "",
  }));
}

// ── Serper.dev Search — compact JSON string for Groq tool calls ───────────────
async function serperSearch(query, apiKey) {
  const results = await serperSearchRaw(query, apiKey);
  return JSON.stringify(results.map(r => ({
    title:       r.title,
    url:         r.url,
    description: r.description.slice(0, 300),
  })));
}

// ── Heuristic enrichment (no LLM) ────────────────────────────────────────────
function heuristicResult(name, email, linkedinUrl, snippet) {
  const companyDomain = inferCompany(email);
  const allText = `${snippet}`.toLowerCase();

  // Industry
  const industry =
    /translat|traductor|interpret|localiz|linguist/i.test(allText) ? "translation" :
    /legal|lawyer|attorney|abogad|notari/i.test(allText)           ? "legal"       :
    /engineer|developer|data|software|analyst|devops/i.test(allText) ? "tech"      :
    /teacher|professor|instructor|educati|docent/i.test(allText)   ? "education"   :
    /market|content|social media|copywrite/i.test(allText)         ? "marketing"   :
    /account|financ|auditor|cfo|controller/i.test(allText)         ? "finance"     :
    "other";

  // Seniority
  const seniority =
    /senior|lead|head|director|chief|principal|manager|founder/i.test(allText) ? "senior"     :
    /junior|intern|trainee|assistant/i.test(allText)                            ? "junior"     :
    /freelance|freelancer|autónomo|self.employed/i.test(allText)                ? "freelancer" :
    "mid";

  // Company — prefer snippet extraction over raw domain
  let company = null, company_source = "not_found";
  const snippetMatch = snippet.match(/[-·|]\s*([A-Z][^·|\n]{3,50})/);
  if (snippetMatch) {
    company = snippetMatch[1].trim().replace(/\s*-\s*LinkedIn.*$/i, "").trim();
    company_source = "snippet";
  } else if (companyDomain) {
    company = companyDomain
      .replace(/\.(com|es|io|org|net|co)$/, "")
      .split(".")[0]
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());
    company_source = "domain_lookup";
  }

  // Interests from keyword map
  const interestMap = {
    "ai": "ai", "machine": "ai", "translation": "translation", "language": "translation",
    "data": "data-science", "design": "design", "finance": "finance",
    "devops": "devops", "open": "open-source", "writing": "writing",
    "education": "education-tech", "legal": "legal-writing",
  };
  const interests = new Set();
  for (const [kw, tag] of Object.entries(interestMap)) {
    if (allText.includes(kw)) interests.add(tag);
  }

  // Role — first segment of snippet before separator
  const roleMatch = snippet.match(/^([^·\-|\n]{5,100})/);
  const current_role = roleMatch
    ? roleMatch[1].trim().replace(/^(LinkedIn\s*[-·]?\s*)/i, "").slice(0, 120) || null
    : null;

  const confidence = linkedinUrl ? 0.72 : (companyDomain ? 0.40 : 0.15);

  return {
    resolved_name:  name,
    company:        company || null,
    company_source,
    current_role:   current_role || null,
    industry,
    seniority,
    country:        null,
    education:      [],
    interests:      [...interests].slice(0, 5),
    confidence,
    needs_review:   confidence < 0.5,
    sources:        linkedinUrl ? ["linkedin"] : [],
    profile_urls:   linkedinUrl ? [linkedinUrl] : [],
    match_notes:    linkedinUrl
      ? `LinkedIn found via search: ${snippet.slice(0, 100)}`
      : (companyDomain
          ? `No LinkedIn match; company inferred from domain ${companyDomain}`
          : "No public profile found"),
  };
}

// ── Fast path: Serper → LinkedIn URL → heuristic result ──────────────────────
// Returns an enriched object if a confident LinkedIn match is found, else null.
async function fastPathEnrich(name, email, serperKey) {
  if (!name) return null;

  const companyDomain = inferCompany(email);
  const query = companyDomain
    ? `site:linkedin.com/in "${name}" "${companyDomain}"`
    : `site:linkedin.com/in "${name}"`;

  let results;
  try {
    results = await serperSearchRaw(query, serperKey, { gl: "es", hl: "es", num: 5 });
  } catch {
    return null; // let Groq handle it
  }

  const linkedinHits = results.filter(r => r.url.includes("linkedin.com/in/"));
  if (linkedinHits.length === 0) return null;

  // Validate: require ≥2 name words (>3 chars) to appear in snippet+title
  const nameWords = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const minMatch  = Math.min(2, nameWords.length);

  const best = linkedinHits.find(r => {
    const text = `${r.title} ${r.description}`.toLowerCase();
    return nameWords.filter(w => text.includes(w)).length >= minMatch;
  });

  if (!best) return null;

  const snippet = `${best.title} ${best.description}`;
  return heuristicResult(name, email, best.url, snippet);
}

const SYSTEM_PROMPT = `You are an OSINT demographic enrichment engine. Given a person's name and/or email, find their PUBLIC professional profile and return structured demographic tags.

PROCESS:
1. COMPANY INFERENCE (when email is provided):
   - Extract the domain (part after @).
   - If it is a generic provider (gmail.com, yahoo.com, hotmail.com, outlook.com, icloud.com, protonmail.com, live.com, me.com, aol.com, mail.com, gmx.com, zoho.com, yandex.com, tutanota.com, yahoo.es, hotmail.es) → company = null, company_source = "not_found".
   - Otherwise → search: "{domain} company LinkedIn" to find the official company name. Set company_source = "domain_lookup".

2. BUILD PRECISION QUERIES — name + company is far more precise than name alone:
   - If company is known: first try  site:linkedin.com/in "{name}" "{company}"
   - If company is known: fallback   "{name}" "{company}" linkedin
   - If no company:                  site:linkedin.com/in "{name}"
   - Always also try:                site:github.com "{email_local_part}" OR "{name}"
   - Run 2–4 searches total, stop when a confident match is found.

3. EXTRACT from ONLY publicly visible results:
   - Exact current job title string (e.g. "Senior Data Scientist at Stripe")
   - Seniority level inferred from title
   - Industry, country/location
   - Education: degree type + field of study + institution, most recent first
   - Up to 5 interest/skill tags

ETHICAL RULES (non-negotiable):
- Only use publicly visible profile data.
- Never infer: religion, health conditions, sexual orientation, politics, family status.
- Return category labels only — never raw scraped text.

FINAL OUTPUT — return a single valid JSON object, no markdown fences, no explanation:
{
  "resolved_name":    string or null,
  "company":          string or null,
  "company_source":   "provided"|"domain_lookup"|"not_found",
  "current_role":     string or null,
  "industry":         "legal"|"tech"|"education"|"translation"|"healthcare"|"finance"|"marketing"|"freelance"|"other" or null,
  "seniority":        "junior"|"mid"|"senior"|"lead"|"manager"|"executive"|"freelancer"|"student"|"unknown" or null,
  "country":          string or null,
  "education":        array of { "degree": "bachelor"|"master"|"phd"|"bootcamp"|"self-taught"|"technical"|null, "field": string or null, "institution": string or null } — most recent first, [] if none found,
  "interests":        array of up to 5 from ["ai","data-science","legal-writing","translation","education-tech","writing","devops","design","finance","open-source"] or [],
  "confidence":       float 0.0-1.0,
  "needs_review":     boolean — true if confidence < 0.3, name is ambiguous, or no profile found,
  "sources":          array of platform names e.g. ["linkedin","github"],
  "profile_urls":     array of direct profile URLs in the same order as "sources" — use exact URLs from web_search, [] if none found,
  "match_notes":      one-sentence summary of what was found or "No public profile found"
}`;

// ── Groq agentic loop ─────────────────────────────────────────────────────────
async function runGroqLoop(name, email, groqKey, serperKey, networks) {
  // Pre-compute company hint from email domain so the LLM starts with context
  let companyHint = "";
  if (email) {
    const domain = email.split("@")[1]?.toLowerCase();
    if (domain && !GENERIC_DOMAINS.has(domain)) {
      companyHint = `\nEmail domain: ${domain} (likely employer — confirm via search)`;
    }
  }

  const userContent = [
    name  && `Full name: ${name}`,
    email && `Email: ${email}`,
  ].filter(Boolean).join("\n") + companyHint;

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
        searchResult = await serperSearch(query, serperKey);
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
  const serperKey = process.env.SERPER_API_KEY;

  if (!serperKey) return { statusCode: 500, body: JSON.stringify({ error: "SERPER_API_KEY not set" }) };

  let name, email, networks;
  try {
    ({ name, email, networks } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!name && !email) {
    return { statusCode: 400, body: JSON.stringify({ error: "Provide at least name or email" }) };
  }

  const corsHeaders = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    // ── Fast path: Serper → LinkedIn → heuristic (no Groq) ──────────────────
    // Skipped when user selects non-LinkedIn networks, since Groq handles those.
    const wantsLinkedInOnly = !networks || networks.length === 0 || (networks.length === 1 && networks[0] === "linkedin");
    if (wantsLinkedInOnly) {
      const fast = await fastPathEnrich(name, email, serperKey);
      if (fast) {
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ name, email, ...fast }) };
      }
    }

    // ── Slow path: Groq agentic loop ─────────────────────────────────────────
    if (!groqKey) {
      // No Groq key and fast path found nothing — return a minimal heuristic result
      const fallback = heuristicResult(name, email, null, "");
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ name, email, ...fallback }) };
    }

    const raw = await runGroqLoop(name, email, groqKey, serperKey, networks);
    // Strip markdown fences, then fall back to extracting first {...} block
    let clean = raw.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    if (!clean.startsWith("{")) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) clean = match[0];
    }
    const result = JSON.parse(clean);
    return {
      statusCode: 200,
      headers:    corsHeaders,
      body:       JSON.stringify({ name, email, ...result }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers:    { "Access-Control-Allow-Origin": "*" },
      body:       JSON.stringify({
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
