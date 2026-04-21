#!/usr/bin/env node
// Real batch enrichment — calls actual /api/enrich endpoint
import fs from "fs";
import path from "path";

const API_URL = process.env.API_URL || "http://localhost:8888";
const ENRICH_ENDPOINT = `${API_URL}/api/enrich`;

function parseAlumnos(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
  const contacts = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length >= 2 && parts[0] && parts[1]) {
      contacts.push({
        name: parts[0],
        email: parts[1],
      });
    }
  }

  return contacts;
}

async function enrichContact(contact) {
  try {
    const res = await fetch(ENRICH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: contact.name || null,
        email: contact.email || null,
        networks: ["linkedin", "github"],
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        ...contact,
        error: data.error || `HTTP ${res.status}`,
        confidence: 0,
      };
    }

    return { ...contact, ...data };
  } catch (err) {
    return {
      ...contact,
      error: err.message,
      confidence: 0,
    };
  }
}

function formatEducation(edu) {
  if (!Array.isArray(edu) || edu.length === 0) return "—";
  return edu
    .map(e => [e.degree, e.field, e.institution].filter(Boolean).join(" · "))
    .join(" | ");
}

function generateMarkdown(results) {
  const summary = {
    total: results.length,
    errors: results.filter(r => r.error).length,
    highConf: results.filter(r => !r.error && (r.confidence || 0) >= 0.75).length,
    medConf: results.filter(r => !r.error && (r.confidence || 0) >= 0.4 && (r.confidence || 0) < 0.75).length,
    lowConf: results.filter(r => !r.error && (r.confidence || 0) < 0.4).length,
  };

  let md = `# OSINT Enrichment Results (Real API)\n\n`;
  md += `**Generated**: ${new Date().toISOString()}\n`;
  md += `**Source**: alumnos.txt (Spanish translation professionals contact list)\n`;
  md += `**Method**: Groq LLM + Serper.dev web search with company inference from email domain\n`;
  md += `**Contacts**: ${results.length} enriched\n\n`;

  md += `## Summary\n`;
  md += `| Metric | Count | Percentage |\n`;
  md += `|--------|-------|------------|\n`;
  md += `| Total Contacts | ${summary.total} | 100% |\n`;
  md += `| High Confidence (≥75%) | ${summary.highConf} | ${(summary.highConf/summary.total*100).toFixed(1)}% |\n`;
  md += `| Medium Confidence (40-75%) | ${summary.medConf} | ${(summary.medConf/summary.total*100).toFixed(1)}% |\n`;
  md += `| Low Confidence (<40%) | ${summary.lowConf} | ${(summary.lowConf/summary.total*100).toFixed(1)}% |\n`;
  md += `| Errors / Failures | ${summary.errors} | ${(summary.errors/summary.total*100).toFixed(1)}% |\n\n`;

  md += `## Top 20 Profiles by Confidence\n\n`;
  results
    .filter(r => !r.error)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 20)
    .forEach((r, i) => {
      md += `### ${i + 1}. ${r.resolved_name || r.name || "Unknown"}\n\n`;
      md += `**Email**: ${r.email}\n`;
      md += `**Company**: ${r.company || "—"} (${r.company_source || "—"})\n`;
      md += `**Current Role**: ${r.current_role || "—"}\n`;
      md += `**Seniority**: ${r.seniority || "—"}\n`;
      md += `**Industry**: ${r.industry || "—"}\n`;
      md += `**Location**: ${r.country || "—"}\n`;
      if (Array.isArray(r.education) && r.education.length > 0) {
        md += `**Education**: ${formatEducation(r.education)}\n`;
      }
      if (Array.isArray(r.interests) && r.interests.length > 0) {
        md += `**Interests**: ${r.interests.join(", ")}\n`;
      }
      md += `**Confidence**: ${Math.round((r.confidence || 0) * 100)}%\n`;
      md += `**Sources**: ${(r.sources || []).join(", ") || "—"}\n`;
      if (Array.isArray(r.profile_urls) && r.profile_urls.length > 0) {
        md += `**Profile URLs**: ${r.profile_urls.map((url, j) => `[${r.sources[j] || "link"}](${url})`).join(", ")}\n`;
      }
      md += `**Notes**: ${r.match_notes || "—"}\n\n`;
    });

  md += `## Full Results Table\n\n`;
  md += `| # | Name | Email | Company | Role | Industry | Confidence | Status |\n`;
  md += `|----|------|-------|---------|------|----------|------------|--------|\n`;

  results.forEach((r, i) => {
    const name = (r.resolved_name || r.name || "—").slice(0, 25);
    const email = (r.email || "—").slice(0, 25);
    const company = (r.company || "—").slice(0, 15);
    const role = (r.current_role || "—").slice(0, 20);
    const industry = r.industry || "—";
    const conf = r.error ? "error" : `${Math.round((r.confidence || 0) * 100)}%`;
    const status = r.error ? "❌" : (r.confidence || 0) >= 0.75 ? "✅" : "⚠";

    md += `| ${i + 1} | ${name} | ${email} | ${company} | ${role} | ${industry} | ${conf} | ${status} |\n`;
  });

  return md;
}

async function main() {
  const alumnosPath = path.join(process.cwd(), "alumnos.txt");

  if (!fs.existsSync(alumnosPath)) {
    console.error(`❌ File not found: ${alumnosPath}`);
    process.exit(1);
  }

  console.log("📖 Parsing alumnos.txt...");
  let contacts = parseAlumnos(alumnosPath);
  console.log(`✓ Found ${contacts.length} contacts`);

  // For testing, use only first 20
  const limit = parseInt(process.env.LIMIT || "20");
  if (limit < contacts.length) {
    contacts = contacts.slice(0, limit);
    console.log(`⚠ Limited to first ${limit} contacts (set LIMIT env var to process more)\n`);
  } else {
    console.log(`Processing all ${contacts.length} contacts\n`);
  }

  console.log("🔄 Enriching contacts...");
  const results = [];
  let processed = 0;
  let errors = 0;

  for (const contact of contacts) {
    try {
      const enriched = await enrichContact(contact);
      results.push(enriched);
      processed++;

      if (enriched.error) {
        errors++;
        console.log(`  [${processed}/${contacts.length}] ❌ ${contact.name}: ${enriched.error.slice(0, 50)}`);
      } else {
        const conf = Math.round((enriched.confidence || 0) * 100);
        console.log(`  [${processed}/${contacts.length}] ✓ ${contact.name} (${conf}%, ${enriched.industry || "—"})`);
      }
    } catch (err) {
      console.error(`  [${processed + 1}/${contacts.length}] ❌ Error enriching ${contact.name}:`, err.message);
      results.push({ ...contact, error: err.message });
      errors++;
    }

    // Rate limiting — 200ms between requests
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n✓ Processed ${processed}/${contacts.length} (${errors} errors)\n`);

  console.log("📝 Generating markdown...");
  const md = generateMarkdown(results);

  const outputPath = path.join(process.cwd(), "enrichment_results_real.md");
  fs.writeFileSync(outputPath, md, "utf-8");
  console.log(`✓ Results written to: ${outputPath}`);

  const jsonPath = path.join(process.cwd(), "enrichment_results_real.json");
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`✓ Raw data written to: ${jsonPath}\n`);

  const high = results.filter(r => !r.error && (r.confidence || 0) >= 0.75).length;
  const med = results.filter(r => !r.error && (r.confidence || 0) >= 0.4 && (r.confidence || 0) < 0.75).length;
  const low = results.filter(r => !r.error && (r.confidence || 0) < 0.4).length;

  console.log(`📊 Summary:`);
  console.log(`   High confidence (≥75%): ${high}`);
  console.log(`   Medium confidence (40-75%): ${med}`);
  console.log(`   Low confidence (<40%): ${low}`);
  console.log(`   Errors: ${errors}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
