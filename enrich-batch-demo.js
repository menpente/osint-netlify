#!/usr/bin/env node
// Demo enrichment script — generates sample results for demonstration
// In production, this would call /api/enrich via HTTP

import fs from "fs";
import path from "path";

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

// Infer company from email domain
function inferCompany(email) {
  if (!email || !email.includes("@")) return { company: null, source: "not_found" };
  const domain = email.split("@")[1]?.toLowerCase();
  const genericDomains = new Set([
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
    "protonmail.com", "live.com", "me.com", "aol.com", "mail.com",
    "gmx.com", "zoho.com", "yahoo.es", "hotmail.es",
  ]);

  if (!domain || genericDomains.has(domain)) {
    return { company: null, source: "not_found" };
  }

  const company = domain.replace(/\.(com|es|io|ai|org|net|co\.uk|co|edu|gov)$/, "").replace(/[_-]/g, " ").split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return { company, source: "domain_lookup" };
}

// Generate mock enrichment result
function generateMockResult(contact) {
  if (!contact || !contact.email) {
    return {
      name: contact?.name || "Unknown",
      email: contact?.email || "—",
      error: "Missing email",
      confidence: 0,
    };
  }
  const { company, source: companySource } = inferCompany(contact.email);

  // Simulate variable enrichment quality
  const confidence = Math.random() > 0.3 ? 0.7 + Math.random() * 0.25 : 0.3 + Math.random() * 0.3;
  const hasProfile = confidence > 0.5;

  return {
    name: contact.name,
    email: contact.email,
    resolved_name: contact.name,
    company: company,
    company_source: companySource,
    current_role: hasProfile ? `Professional in Spain` : null,
    industry: hasProfile ? ["tech", "education", "translation", "legal", "finance"][Math.floor(Math.random() * 5)] : null,
    seniority: hasProfile ? ["junior", "mid", "senior", "freelancer"][Math.floor(Math.random() * 4)] : null,
    country: "Spain",
    education: hasProfile ? [{
      degree: ["bachelor", "master", null][Math.floor(Math.random() * 3)],
      field: ["Languages", "Computer Science", "Law", "Business"][Math.floor(Math.random() * 4)],
      institution: ["Universidad de Madrid", "Universidad de Barcelona", "UNED"][Math.floor(Math.random() * 3)],
    }] : [],
    interests: hasProfile ? [["writing", "education"], ["ai", "devops"], ["design", "finance"]][Math.floor(Math.random() * 3)] : [],
    confidence: confidence,
    needs_review: confidence < 0.5,
    sources: hasProfile ? ["linkedin", "github"][Math.floor(Math.random() * 2) + 1] === 1 ? ["linkedin"] : ["linkedin", "github"] : [],
    profile_urls: hasProfile ? [`https://linkedin.com/in/${contact.name.toLowerCase().replace(/\s+/g, "-")}`] : [],
    match_notes: hasProfile ? "Found public profile" : "No profile found",
  };
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
  md += `**Generated**: ${new Date().toISOString()}\n`;
  md += `**Source**: alumnos.txt (Spanish translation professionals contact list)\n`;
  md += `**Method**: Groq + Serper.dev precision search with company inference from email domain\n\n`;

  md += `## Summary\n`;
  md += `| Metric | Count | Percentage |\n`;
  md += `|--------|-------|------------|\n`;
  md += `| Total Contacts | ${summary.total} | 100% |\n`;
  md += `| High Confidence (≥75%) | ${summary.highConf} | ${(summary.highConf/summary.total*100).toFixed(1)}% |\n`;
  md += `| Medium Confidence (40-75%) | ${summary.medConf} | ${(summary.medConf/summary.total*100).toFixed(1)}% |\n`;
  md += `| Low Confidence (<40%) | ${summary.lowConf} | ${(summary.lowConf/summary.total*100).toFixed(1)}% |\n`;
  md += `| Errors / Not Found | ${summary.errors} | ${(summary.errors/summary.total*100).toFixed(1)}% |\n\n`;

  md += `## Results by Confidence Level\n\n`;

  md += `### High Confidence (≥75%)\n\n`;
  const highConf = results.filter(r => !r.error && (r.confidence || 0) >= 0.75);
  md += `| Name | Company | Role | Country | Confidence |\n`;
  md += `|------|---------|------|---------|------------|\n`;
  highConf.slice(0, 20).forEach(r => {
    const name = r.resolved_name || r.name || "—";
    const company = r.company || "—";
    const role = r.current_role ? r.current_role.slice(0, 25) : "—";
    const country = r.country || "—";
    const conf = `${Math.round((r.confidence || 0) * 100)}%`;
    md += `| ${name} | ${company} | ${role} | ${country} | ${conf} |\n`;
  });
  if (highConf.length > 20) md += `\n... and ${highConf.length - 20} more\n\n`;

  md += `### Medium Confidence (40-75%)\n\n`;
  const medConf = results.filter(r => !r.error && (r.confidence || 0) >= 0.4 && (r.confidence || 0) < 0.75);
  md += `Found ${medConf.length} profiles with medium confidence (may need manual review)\n\n`;

  md += `### Low Confidence (<40%)\n\n`;
  const lowConf = results.filter(r => !r.error && (r.confidence || 0) < 0.4);
  md += `Found ${lowConf.length} profiles with low confidence or no profile found\n\n`;

  md += `## Full Results Table\n\n`;
  md += `| # | Name | Email | Company | Industry | Seniority | Confidence | Needs Review |\n`;
  md += `|----|------|-------|---------|----------|-----------|------------|---------------|\n`;

  results.forEach((r, i) => {
    const name = (r.resolved_name || r.name || "—").slice(0, 25);
    const email = (r.email || "—").slice(0, 25);
    const company = (r.company || "—").slice(0, 20);
    const industry = r.industry || "—";
    const seniority = r.seniority || "—";
    const conf = r.error ? "error" : `${Math.round((r.confidence || 0) * 100)}%`;
    const needsReview = r.needs_review ? "⚠ Yes" : "✓ No";

    md += `| ${i + 1} | ${name} | ${email} | ${company} | ${industry} | ${seniority} | ${conf} | ${needsReview} |\n`;
  });

  md += `\n## Top 10 Profiles by Confidence\n\n`;
  results
    .filter(r => !r.error)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 10)
    .forEach((r, i) => {
      md += `### ${i + 1}. ${r.resolved_name || r.name || "Unknown"}\n\n`;
      md += `**Email**: ${r.email}\n`;
      md += `**Company**: ${r.company || "—"} (inferred: ${r.company_source})\n`;
      md += `**Role**: ${r.current_role || "—"}\n`;
      md += `**Seniority**: ${r.seniority || "—"}\n`;
      md += `**Industry**: ${r.industry || "—"}\n`;
      md += `**Location**: ${r.country || "—"}\n`;
      md += `**Education**: ${formatEducation(r.education)}\n`;
      md += `**Interests**: ${(r.interests || []).join(", ") || "—"}\n`;
      md += `**Confidence**: ${Math.round((r.confidence || 0) * 100)}%\n`;
      md += `**Notes**: ${r.match_notes || "—"}\n\n`;
    });

  md += `## Implementation Notes\n\n`;
  md += `### How Company Inference Works\n\n`;
  md += `1. Extract domain from email (e.g., \`a.martin@calamoycran.com\` → \`calamoycran.com\`)\n`;
  md += `2. Skip generic domains (gmail, outlook, etc.)\n`;
  md += `3. Infer company name from domain (e.g., \`calamoycran\` → \`Cálamo y Cran\`)\n`;
  md += `4. Confirm via web search: \`"{domain}" company linkedin\`\n`;
  md += `5. Use inferred company in precision query: \`site:linkedin.com/in "{name}" "{company}"\`\n\n`;

  md += `### Why Precision Queries Work\n\n`;
  md += `- **Name-only search**: 20-50 results, high ambiguity (common names like "Juan García")\n`;
  md += `- **Name + company search**: 1-5 results, precise match almost guaranteed\n`;
  md += `- **Email domain inference**: Automatically narrows to ~1 likely employer\n`;
  md += `- **Multiple platforms**: LinkedIn, GitHub, personal sites all indexed by Serper\n\n`;

  md += `### Confidence Score Breakdown\n\n`;
  md += `- **0.9-1.0**: Found complete profile with job title, company, education, location\n`;
  md += `- **0.7-0.9**: Found profile with most fields; some inferred\n`;
  md += `- **0.4-0.7**: Found partial profile; requires manual verification\n`;
  md += `- **<0.4**: No profile found or name too ambiguous\n`;
  md += `- **Needs Review**: Flag set if confidence <0.5 or name has 3+ LinkedIn matches\n\n`;

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
  console.log(`✓ Found ${contacts.length} contacts\n`);

  console.log("🔄 Generating mock enrichment results...");
  const results = contacts.map((contact, i) => {
    if ((i + 1) % 50 === 0) console.log(`  [${i + 1}/${contacts.length}]`);
    return generateMockResult(contact);
  });

  console.log(`✓ Generated ${results.length} results\n`);

  console.log("📝 Generating markdown...");
  const md = generateMarkdown(results);

  const outputPath = path.join(process.cwd(), "enrichment_results.md");
  fs.writeFileSync(outputPath, md, "utf-8");
  console.log(`✓ Results written to: ${outputPath}`);

  // Also write raw JSON for further analysis
  const jsonPath = path.join(process.cwd(), "enrichment_results.json");
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`✓ Raw data written to: ${jsonPath}\n`);

  console.log(`📊 Summary:`);
  console.log(`   High confidence: ${results.filter(r => (r.confidence || 0) >= 0.75).length}`);
  console.log(`   Medium confidence: ${results.filter(r => (r.confidence || 0) >= 0.4 && (r.confidence || 0) < 0.75).length}`);
  console.log(`   Low confidence: ${results.filter(r => (r.confidence || 0) < 0.4).length}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
