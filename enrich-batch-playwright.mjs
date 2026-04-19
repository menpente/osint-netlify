#!/usr/bin/env node
// Autonomous batch enrichment using Playwright — searches LinkedIn for each contact
// Run: node enrich-batch-playwright.mjs

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const CONTACTS_FILE  = 'alumnos.txt';
const RESULTS_FILE   = 'enrichment_results_playwright.json';
const DELAY_MS       = 1000; // polite delay between requests
const SERPER_API_KEY = process.env.SERPER_API_KEY || (() => {
  // Load from .env.local
  try {
    const env = fs.readFileSync('.env.local', 'utf-8');
    return env.match(/SERPER_API_KEY=(.+)/)?.[1]?.trim();
  } catch { return null; }
})();

function parseAlumnos(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const contacts = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length >= 2 && parts[0] && parts[1])
      contacts.push({ name: parts[0], email: parts[1] });
  }
  return contacts;
}

function loadResults() {
  if (fs.existsSync(RESULTS_FILE))
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
  return [];
}

function saveResult(results, entry) {
  results.push(entry);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}

function inferCompany(email) {
  const GENERIC = new Set([
    'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
    'protonmail.com','live.com','me.com','aol.com','mail.com',
    'gmx.com','zoho.com','yandex.com','tutanota.com','yahoo.es','hotmail.es','msn.com',
  ]);
  if (!email?.includes('@')) return null;
  const domain = email.split('@')[1]?.toLowerCase();
  return (!domain || GENERIC.has(domain)) ? null : domain;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchSerper(name, companyDomain) {
  const query = companyDomain
    ? `site:linkedin.com/in "${name}" "${companyDomain}"`
    : `site:linkedin.com/in "${name}" traductor OR translator`;

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 5, gl: 'es', hl: 'es' }),
  });
  if (!res.ok) throw new Error(`Serper ${res.status}`);
  const data = await res.json();
  return (data.organic || []).slice(0, 3).map(r => ({
    url: r.link?.split('?')[0] || '',
    text: `${r.title || ''} ${r.snippet || ''}`,
  })).filter(r => r.url.includes('linkedin.com/in/'));
}

async function extractLinkedInProfile(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(1000);

    // Check for auth wall
    const isAuthWall = await page.evaluate(() =>
      document.title.includes('Sign') || document.querySelector('.authwall-join-form') !== null
    );

    return await page.evaluate((isAuthWall) => {
      const text = (sel) => document.querySelector(sel)?.innerText?.trim() || null;
      const all  = (sel) => [...document.querySelectorAll(sel)].map(e => e.innerText?.trim()).filter(Boolean);

      const name     = text('h1');
      const headline = text('h2') || text('.top-card-layout__headline') || text('.text-body-medium');
      const location = text('.top-card__subline-item') || text('[class*="location"]');
      const about    = text('section.summary .pv-shared-text-with-see-more') || text('[data-section="summary"]');

      // Experience items
      const company = text('a[data-field="experience_company_logo"]') ||
                      text('.experience-item__subtitle') ||
                      text('[aria-label*="company"]');

      // Education
      const eduItems = all('.education__list-item h3, .education-item h3').slice(0, 3);

      // Languages
      const langs = all('.languages__list-item h3, .pv-accomplishments-block__list-item').slice(0, 5);

      // Courses / interests
      const courses = all('.certifications__list-item h3, .courses__list-item h3').slice(0, 5);

      // Volunteer
      const volunteer = all('.volunteering__list-item h3').slice(0, 2);

      return { name, headline, location, about, company, eduItems, langs, courses, volunteer, isAuthWall };
    }, isAuthWall);
  } catch {
    return null;
  }
}

function parseEnrichment(name, email, linkedinUrl, googleSnippet, liProfile) {
  // Derive fields from whatever we have
  const snippet = googleSnippet || '';
  const headline = liProfile?.headline || '';
  const allText  = `${snippet} ${headline}`.toLowerCase();

  // Role detection
  const isTranslator   = /translat|traductor|interpret|localiz|linguist/i.test(allText);
  const isLegal        = /legal|lawyer|attorney|abogad|notari/i.test(allText);
  const isTech         = /engineer|developer|data|software|analyst|devops/i.test(allText);
  const isEducation    = /teacher|professor|instructor|educati|docent/i.test(allText);
  const isMarketing    = /market|content|social media|copywrite/i.test(allText);
  const isFinance      = /account|financ|auditor|cfo|controller/i.test(allText);

  const industry = isTranslator ? 'translation'
    : isLegal ? 'legal' : isTech ? 'tech'
    : isEducation ? 'education' : isMarketing ? 'marketing'
    : isFinance ? 'finance' : 'other';

  const isSenior    = /senior|lead|head|director|chief|principal|manager|founder/i.test(allText);
  const isJunior    = /junior|intern|trainee|assistant/i.test(allText);
  const isFreelance = /freelance|freelancer|autónomo|self.employed/i.test(allText);
  const seniority   = isSenior ? 'senior' : isJunior ? 'junior' : isFreelance ? 'freelancer' : 'mid';

  // Company — prefer LinkedIn profile, fall back to domain
  const companyDomain = inferCompany(email);
  let company = liProfile?.company || null;
  let companySource = 'not_found';
  if (company) {
    companySource = 'linkedin';
  } else if (companyDomain) {
    company = companyDomain.replace(/\.(com|es|io|org|net)$/, '')
      .split('.')[0].replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
    companySource = 'domain_lookup';
  }

  // Extract company from snippet if still null
  if (!company) {
    const m = snippet.match(/[-·]\s*([A-Z][^·\n]{3,40})/);
    if (m) { company = m[1].trim(); companySource = 'snippet'; }
  }

  const location = liProfile?.location || (snippet.includes('Spain') || snippet.includes('España') ? 'Spain' : null);
  const confidence = linkedinUrl
    ? (liProfile && !liProfile.isAuthWall ? 0.88 : 0.72)
    : (companyDomain ? 0.40 : 0.15);

  return {
    name, email,
    resolved_name: liProfile?.name || name,
    company, company_source: companySource,
    current_role: liProfile?.headline || null,
    seniority, industry,
    country: 'Spain',
    location: location || 'Spain',
    education: (liProfile?.eduItems || []).map(e => ({ institution: e, degree: null, field: null })),
    languages: liProfile?.langs || [],
    interests: courses_to_interests(liProfile?.courses || []),
    confidence,
    needs_review: confidence < 0.5,
    sources: linkedinUrl ? ['linkedin'] : [],
    profile_urls: linkedinUrl ? [linkedinUrl] : [],
    match_notes: linkedinUrl
      ? `Found LinkedIn: ${liProfile?.headline || snippet.slice(0, 80)}`
      : (companyDomain ? `No LinkedIn match; company inferred from domain ${companyDomain}` : 'No public profile found')
  };
}

function courses_to_interests(courses) {
  const map = {
    'ai': 'ai', 'machine': 'ai', 'translation': 'translation', 'language': 'translation',
    'data': 'data-science', 'design': 'design', 'finance': 'finance',
    'devops': 'devops', 'open': 'open-source', 'writing': 'writing',
    'education': 'education-tech', 'legal': 'legal-writing',
  };
  const found = new Set();
  for (const c of courses) {
    for (const [kw, tag] of Object.entries(map)) {
      if (c.toLowerCase().includes(kw)) found.add(tag);
    }
  }
  return [...found].slice(0, 5);
}

async function main() {
  const contacts = parseAlumnos(CONTACTS_FILE);
  const results  = loadResults();
  const done     = new Set(results.map(r => r.name));
  const pending  = contacts.filter(c => !done.has(c.name));

  console.log(`Total: ${contacts.length} | Done: ${done.size} | Remaining: ${pending.length}\n`);
  if (pending.length === 0) { console.log('All done!'); return; }

  if (!SERPER_API_KEY) { console.error('SERPER_API_KEY not found'); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  const page    = await ctx.newPage();

  let processed = 0, found = 0, errors = 0;

  for (const contact of pending) {
    const idx = done.size + processed + 1;
    try {
      const companyDomain = inferCompany(contact.email);

      // Step 1: Serper → find LinkedIn URL
      const googleResults = await searchSerper(contact.name, companyDomain);
      await sleep(300);

      let linkedinUrl = null;
      let googleSnippet = '';
      let liProfile = null;

      if (googleResults.length > 0) {
        linkedinUrl  = googleResults[0].url;
        googleSnippet = googleResults[0].text;

        // Step 2: LinkedIn profile
        liProfile = await extractLinkedInProfile(page, linkedinUrl);
        await sleep(DELAY_MS);

        // Validate match — name should roughly appear in snippet or profile
        const nameWords = contact.name.toLowerCase().split(' ').filter(w => w.length > 3);
        const matchText = `${googleSnippet} ${liProfile?.name || ''}`.toLowerCase();
        const nameMatch = nameWords.filter(w => matchText.includes(w)).length;
        if (nameMatch < 2) {
          linkedinUrl = null; liProfile = null; // reject weak match
        } else {
          found++;
        }
      }

      const enriched = parseEnrichment(contact.name, contact.email, linkedinUrl, googleSnippet, liProfile);
      saveResult(results, enriched);
      processed++;

      const conf = Math.round(enriched.confidence * 100);
      const icon = enriched.confidence >= 0.7 ? '✅' : enriched.confidence >= 0.4 ? '⚠️' : '❌';
      console.log(`[${idx}/${contacts.length}] ${icon} ${contact.name} (${conf}%, ${enriched.industry}) ${linkedinUrl ? '→ ' + linkedinUrl : ''}`);

    } catch (err) {
      console.error(`[${idx}/${contacts.length}] ❌ ERROR ${contact.name}: ${err.message}`);
      saveResult(results, {
        name: contact.name, email: contact.email,
        confidence: 0, needs_review: true,
        error: err.message, match_notes: 'Processing error'
      });
      errors++;
      processed++;
    }
  }

  await browser.close();

  console.log(`\n✅ Done: ${processed} processed, ${found} LinkedIn matches, ${errors} errors`);
  console.log(`📄 Results: ${RESULTS_FILE}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
