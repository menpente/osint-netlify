#!/usr/bin/env node
// Batch enrichment script — reads alumnos.txt, calls /api/enrich for each contact

import fs from "fs";
import path from "path";

const API_URL = process.env.API_URL || "http://localhost:3000";
const ENRICH_ENDPOINT = `${API_URL}/api/enrich`;

function parseAlumnos(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
  const contacts = [];

  for (let i = 1; i < lines.length; i++) {
    // skip header
    const parts = lines[i].split("\t");
    if (parts.length >= 2) {
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

    if (!res.ok) {
      return {
        ...contact,
        error: `HTTP ${res.status}`,
        confidence: 0,
      };
    }

    const data = await res.json();
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

  let md = `# OSINT Enrichment Results\n\n`;
  md += `**Generated**: ${new Date().toISOString()}\n\n`;

  md += `## Summary\n`;
  md += `| Metric | Count |\n`;
  md += `|--------|-------|\n`;
  md += `| Total | ${summary.total} |\n`;
  md += `| High Confidence (≥75%) | ${summary.highConf} |\n`;
  md += `| Medium Confidence (40-75%) | ${summary.medConf} |\n`;
  md += `| Low Confidence (<40%) | ${summary.lowConf} |\n`;
  md += `| Errors | ${summary.errors} |\n\n`;

  md += `## Results Table\n\n`;
  md += `| Name | Email | Company | Role | Industry | Seniority | Country | Education | Confidence | Needs Review |\n`;
  md += `|------|-------|---------|------|----------|-----------|---------|-----------|------------|---------------|\n`;

  results.forEach(r => {
    const name = r.resolved_name || r.name || "—";
    const email = r.email || "—";
    const company = r.company || "—";
    const role = r.current_role ? r.current_role.slice(0, 30) : "—";
    const industry = r.industry || "—";
    const seniority = r.seniority || "—";
    const country = r.country || "—";
    const education = formatEducation(r.education);
    const conf = r.error ? "error" : `${Math.round((r.confidence || 0) * 100)}%`;
    const needsReview = r.needs_review ? "⚠" : "✓";

    md += `| ${name} | ${email} | ${company} | ${role} | ${industry} | ${seniority} | ${country} | ${education} | ${conf} | ${needsReview} |\n`;
  });

  md += `\n## Detailed Results\n\n`;

  results.forEach((r, i) => {
    md += `### ${i + 1}. ${r.resolved_name || r.name || "Unknown"}\n\n`;
    md += `**Email**: ${r.email || "—"}\n\n`;

    if (r.error) {
      md += `**Status**: ⚠ Error: ${r.error}\n\n`;
    } else {
      md += `**Company**: ${r.company || "—"} (${r.company_source || "—"})\n\n`;
      md += `**Current Role**: ${r.current_role || "—"}\n\n`;
      md += `**Seniority**: ${r.seniority || "—"}\n\n`;
      md += `**Industry**: ${r.industry || "—"}\n\n`;
      md += `**Location**: ${r.country || "—"}\n\n`;

      if (Array.isArray(r.education) && r.education.length > 0) {
        md += `**Education**:\n`;
        r.education.forEach(e => {
          md += `- ${[e.degree, e.field, e.institution].filter(Boolean).join(" · ")}\n`;
        });
        md += `\n`;
      }

      if (Array.isArray(r.interests) && r.interests.length > 0) {
        md += `**Interests**: ${r.interests.join(", ")}\n\n`;
      }

      if (Array.isArray(r.sources) && r.sources.length > 0) {
        md += `**Sources**: ${r.sources.join(", ")}\n\n`;
        if (Array.isArray(r.profile_urls) && r.profile_urls.length > 0) {
          md += `**Profile URLs**:\n`;
          r.sources.forEach((src, idx) => {
            const url = r.profile_urls[idx];
            if (url) md += `- [${src}](${url})\n`;
          });
          md += `\n`;
        }
      }

      md += `**Confidence**: ${Math.round((r.confidence || 0) * 100)}%\n`;
      md += `**Needs Review**: ${r.needs_review ? "Yes ⚠" : "No ✓"}\n`;
      md += `**Notes**: ${r.match_notes || "—"}\n\n`;
    }
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
  const contacts = parseAlumnos(alumnosPath);
  console.log(`✓ Found ${contacts.length} contacts`);

  console.log("\n🔄 Enriching contacts...");
  const results = [];
  let processed = 0;

  for (const contact of contacts) {
    try {
      const enriched = await enrichContact(contact);
      results.push(enriched);
      processed++;

      if (processed % 10 === 0) {
        console.log(`  [${processed}/${contacts.length}] Processing...`);
      }
    } catch (err) {
      console.error(`  ❌ Error enriching ${contact.name}:`, err.message);
      results.push({ ...contact, error: err.message });
    }

    // Rate limiting — be nice to the API
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`✓ Enriched ${processed}/${contacts.length}\n`);

  console.log("📝 Generating markdown...");
  const md = generateMarkdown(results);

  const outputPath = path.join(process.cwd(), "enrichment_results.md");
  fs.writeFileSync(outputPath, md, "utf-8");

  console.log(`✓ Results written to: ${outputPath}`);

  // Also write raw JSON for further analysis
  const jsonPath = path.join(process.cwd(), "enrichment_results.json");
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`✓ Raw data written to: ${jsonPath}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
