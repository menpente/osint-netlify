import { useState, useRef, useCallback } from "react";

// ── Network options ───────────────────────────────────────────────────────────
const NETWORKS = [
  { id: "linkedin",      label: "LinkedIn" },
  { id: "github",        label: "GitHub" },
  { id: "twitter",       label: "Twitter/X" },
  { id: "instagram",     label: "Instagram" },
  { id: "facebook",      label: "Facebook" },
  { id: "researchgate",  label: "ResearchGate" },
  { id: "medium",        label: "Medium" },
  { id: "stackoverflow", label: "Stack Overflow" },
];

// ── API call ──────────────────────────────────────────────────────────────────
async function enrichContact({ name, email }, networks) {
  const res = await fetch("/api/enrich", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ name: name || null, email: email || null, networks }),
  });
  const data = await res.json();
  if (data.error && !data.match_notes) throw new Error(data.error);
  return { name, email, ...data };
}

// ── File parser ───────────────────────────────────────────────────────────────
function parseContacts(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    if (/^(name|email|nombre|correo)/i.test(line)) return null;
    if (line.includes("\t")) {
      const [a, b] = line.split("\t").map(s => s.trim());
      if (b?.includes("@")) return { name: a || null, email: b };
      if (a?.includes("@")) return { name: b || null, email: a };
    }
    if (line.includes(",")) {
      const parts = line.split(",").map(s => s.trim().replace(/^"|"$/g, ""));
      const emailPart = parts.find(p => p.includes("@"));
      const namePart  = parts.find(p => !p.includes("@") && p.length > 1);
      if (emailPart) return { name: namePart || null, email: emailPart };
    }
    if (line.includes("@")) return { name: null,  email: line.toLowerCase() };
    if (line.length > 2)    return { name: line,  email: null };
    return null;
  }).filter(Boolean);
}

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV(results) {
  const headers = ["name","email","resolved_name","industry","role","country",
                   "education_level","interests","confidence","sources","profile_urls","match_notes"];
  const rows = results.map(r =>
    headers.map(h => {
      const v = r[h];
      return `"${Array.isArray(v) ? v.join(";") : (v ?? "")}"`;
    }).join(",")
  );
  const blob = new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "enriched_contacts.csv";
  a.click();
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:      "#080d14",
  surface: "#0f172a",
  border:  "#1e293b",
  muted:   "#334155",
  dim:     "#64748b",
  mid:     "#94a3b8",
  text:    "#e2e8f0",
  purple:  "#6366f1",
  pink:    "#ec4899",
  sky:     "#0ea5e9",
  amber:   "#f59e0b",
  green:   "#4ade80",
  red:     "#f87171",
  teal:    "#10b981",
};

const BADGE = {
  industry:        C.purple,
  role:            C.pink,
  country:         C.sky,
  education_level: C.amber,
  interests:       C.teal,
};

const confColor = c => c >= 0.75 ? C.green : c >= 0.4 ? C.amber : C.red;

// ── Tiny components ───────────────────────────────────────────────────────────
function Tag({ label, color }) {
  return (
    <span style={{
      background: color + "22", color, border: `1px solid ${color}44`,
      borderRadius: 4, padding: "1px 8px", fontSize: 11,
      fontFamily: "monospace", whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

function ProgressBar({ value, total }) {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div style={{ margin: "12px 0" }}>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color: C.mid, marginBottom:4 }}>
        <span>Processing {value} / {total}</span><span>{pct}%</span>
      </div>
      <div style={{ background: C.border, borderRadius:99, height:6, overflow:"hidden" }}>
        <div style={{
          width:`${pct}%`, height:"100%",
          background:`linear-gradient(90deg,${C.purple},${C.pink})`,
          borderRadius:99, transition:"width 0.4s ease",
        }} />
      </div>
    </div>
  );
}

// ── Result row ────────────────────────────────────────────────────────────────
function ResultRow({ row, idx }) {
  const [open, setOpen] = useState(false);
  const bg = idx % 2 === 0 ? C.bg : "#0b1320";
  return (
    <>
      <tr
        onClick={() => setOpen(o => !o)}
        style={{ cursor:"pointer", background:bg, borderBottom:`1px solid ${C.border}` }}
        onMouseEnter={e => e.currentTarget.style.background = C.border}
        onMouseLeave={e => e.currentTarget.style.background = bg}
      >
        {/* Contact */}
        <td style={{ padding:"10px 14px" }}>
          <div style={{ fontSize:13, color: C.text, fontWeight:500 }}>
            {row.resolved_name || row.name || "—"}
          </div>
          {row.email && (
            <div style={{ fontSize:11, color: C.dim, fontFamily:"monospace", marginTop:1 }}>
              {row.email}
            </div>
          )}
        </td>
        {/* Industry */}
        <td style={{ padding:"10px 8px" }}>
          {row.industry && <Tag label={row.industry} color={BADGE.industry} />}
        </td>
        {/* Role */}
        <td style={{ padding:"10px 8px" }}>
          {row.role && <Tag label={row.role} color={BADGE.role} />}
        </td>
        {/* Location */}
        <td style={{ padding:"10px 8px", fontSize:12, color: C.mid }}>
          {row.country || "—"}
        </td>
        {/* Education */}
        <td style={{ padding:"10px 8px" }}>
          {row.education_level && <Tag label={row.education_level} color={BADGE.education_level} />}
        </td>
        {/* Interests */}
        <td style={{ padding:"10px 8px" }}>
          <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
            {(row.interests||[]).slice(0,3).map(i => <Tag key={i} label={i} color={BADGE.interests} />)}
            {(row.interests||[]).length > 3 && (
              <Tag label={`+${row.interests.length-3}`} color={C.muted} />
            )}
          </div>
        </td>
        {/* Sources */}
        <td style={{ padding:"10px 8px" }}>
          <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
            {(row.sources||[]).slice(0,3).map((s, i) => {
              const url = (row.profile_urls||[])[i];
              const tag = <Tag key={s} label={s} color={C.sky} />;
              return url
                ? <a key={s} href={url} target="_blank" rel="noopener noreferrer"
                     onClick={e => e.stopPropagation()}
                     style={{ textDecoration:"none" }}>{tag}</a>
                : tag;
            })}
            {(row.sources||[]).length > 3 && (
              <Tag label={`+${row.sources.length-3}`} color={C.muted} />
            )}
          </div>
        </td>
        {/* Confidence */}
        <td style={{ padding:"10px 14px", textAlign:"right" }}>
          {row.error
            ? <span style={{ color: C.red, fontSize:12 }}>error</span>
            : <span style={{ color: confColor(row.confidence||0), fontFamily:"monospace", fontSize:13, fontWeight:700 }}>
                {Math.round((row.confidence||0)*100)}%
              </span>
          }
        </td>
      </tr>
      {open && (
        <tr style={{ background: C.border }}>
          <td colSpan={8} style={{ padding:"10px 14px" }}>
            <div style={{ display:"flex", gap:24, flexWrap:"wrap", fontSize:12 }}>
              <div>
                <span style={{ color: C.dim, textTransform:"uppercase", letterSpacing:1 }}>All interests </span>
                <span style={{ color: C.mid }}>{(row.interests||[]).join(", ")||"—"}</span>
              </div>
              <div style={{ flex:1 }}>
                <span style={{ color: C.dim, textTransform:"uppercase", letterSpacing:1 }}>Notes </span>
                <span style={{ color: C.text }}>{row.match_notes||"—"}</span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Format hint panel ─────────────────────────────────────────────────────────
const FORMATS = [
  { label:"Email only",         ex:"ana@example.com" },
  { label:"Name only",          ex:"Ana García" },
  { label:"Name, Email (CSV)",  ex:"Ana García, ana@example.com" },
  { label:"Name  Email (TSV)",  ex:"Ana García\tana@example.com" },
];

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [contacts,         setContacts]         = useState([]);
  const [results,          setResults]          = useState([]);
  const [processing,       setProcessing]       = useState(false);
  const [done,             setDone]             = useState(0);
  const [dragOver,         setDragOver]         = useState(false);
  const [fileName,         setFileName]         = useState(null);
  const [showFormats,      setShowFormats]      = useState(false);
  const [globalError,      setGlobalError]      = useState(null);
  const [selectedNetworks, setSelectedNetworks] = useState(["linkedin"]);
  const fileRef = useRef();

  const toggleNetwork = (id) =>
    setSelectedNetworks(prev =>
      prev.includes(id) ? prev.filter(n => n !== id) : [...prev, id]
    );

  const parseFile = useCallback((file) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      const parsed = parseContacts(e.target.result);
      setContacts(parsed); setResults([]); setDone(0); setGlobalError(null);
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback(e => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const handleRun = async () => {
    if (!contacts.length) return;
    setProcessing(true); setResults([]); setDone(0); setGlobalError(null);
    for (let i = 0; i < contacts.length; i++) {
      try {
        const row = await enrichContact(contacts[i], selectedNetworks);
        setResults(prev => [...prev, row]);
      } catch (err) {
        if (err.message.includes("API_KEY")) {
          setGlobalError("API keys not configured. Check Netlify environment variables.");
          setProcessing(false); return;
        }
        setResults(prev => [...prev, {
          ...contacts[i], error: err.message,
          match_notes:"Request failed", confidence:0, sources:[], interests:[],
        }]);
      }
      setDone(i + 1);
    }
    setProcessing(false);
  };

  const withBoth  = contacts.filter(c => c.name && c.email).length;
  const nameOnly  = contacts.filter(c => c.name && !c.email).length;
  const emailOnly = contacts.filter(c => !c.name && c.email).length;

  return (
    <div style={{ minHeight:"100vh", background: C.bg, fontFamily:"'DM Sans','Segoe UI',sans-serif", color: C.text, paddingBottom:60 }}>

      {/* ── Header ── */}
      <header style={{
        borderBottom:`1px solid ${C.border}`, padding:"20px 32px",
        display:"flex", alignItems:"center", gap:14,
        background:"rgba(8,13,20,0.95)", backdropFilter:"blur(10px)",
        position:"sticky", top:0, zIndex:10,
      }}>
        <div style={{
          width:38, height:38, borderRadius:9, flexShrink:0,
          background:`linear-gradient(135deg,${C.purple},${C.pink})`,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:19,
        }}>🔍</div>
        <div>
          <div style={{ fontWeight:700, fontSize:16, letterSpacing:-0.3 }}>
            OSINT Demographics Enricher
          </div>
          <div style={{ fontSize:12, color: C.dim }}>
            Powered by Groq + Serper · Name · Email · or both
          </div>
        </div>
        {results.length > 0 && !processing && (
          <button
            onClick={() => exportCSV(results)}
            style={{
              marginLeft:"auto", background:"transparent",
              border:`1px solid ${C.muted}`, color: C.mid,
              borderRadius:6, padding:"7px 16px", fontSize:13, cursor:"pointer",
              transition:"all 0.15s",
            }}
            onMouseEnter={e => { e.currentTarget.style.border=`1px solid ${C.purple}`; e.currentTarget.style.color="#a5b4fc"; }}
            onMouseLeave={e => { e.currentTarget.style.border=`1px solid ${C.muted}`;  e.currentTarget.style.color= C.mid; }}
          >
            ↓ Export CSV
          </button>
        )}
      </header>

      <main style={{ maxWidth:1200, margin:"0 auto", padding:"28px 32px 0" }}>

        {/* ── Format hint ── */}
        <div style={{ marginBottom:12 }}>
          <button
            onClick={() => setShowFormats(f => !f)}
            style={{ background:"transparent", border:"none", color: C.dim, fontSize:12, cursor:"pointer", padding:0 }}
          >
            {showFormats ? "▾" : "▸"} Supported file formats
          </button>
          {showFormats && (
            <div style={{
              marginTop:8, background: C.surface, border:`1px solid ${C.border}`,
              borderRadius:8, padding:"14px 18px", display:"flex", gap:28, flexWrap:"wrap",
            }}>
              {FORMATS.map(f => (
                <div key={f.label}>
                  <div style={{ fontSize:10, color: C.dim, textTransform:"uppercase", letterSpacing:1.2, marginBottom:3 }}>{f.label}</div>
                  <code style={{ fontSize:12, color: C.mid }}>{f.ex}</code>
                </div>
              ))}
              <div style={{ fontSize:11, color: C.muted, alignSelf:"center" }}>
                One contact per line · Name+Email gives best accuracy
              </div>
            </div>
          )}
        </div>

        {/* ── Upload zone ── */}
        <div
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => fileRef.current.click()}
          style={{
            border:`2px dashed ${dragOver ? C.purple : C.border}`,
            borderRadius:12, padding:"44px 24px", textAlign:"center",
            cursor:"pointer", transition:"all 0.2s", marginBottom:20,
            background: dragOver ? "#1e1b4b18" : C.surface,
          }}
        >
          <input
            ref={fileRef} type="file" accept=".txt,.csv,.tsv"
            style={{ display:"none" }}
            onChange={e => e.target.files[0] && parseFile(e.target.files[0])}
          />
          <div style={{ fontSize:36, marginBottom:10 }}>📄</div>
          {fileName ? (
            <>
              <div style={{ fontSize:15, color:"#a5b4fc", fontWeight:600 }}>{fileName}</div>
              <div style={{ fontSize:13, color: C.dim, marginTop:8, display:"flex", justifyContent:"center", gap:18, flexWrap:"wrap" }}>
                {withBoth  > 0 && <span><strong style={{ color: C.green }}>{withBoth}</strong> name + email</span>}
                {nameOnly  > 0 && <span><strong style={{ color: C.amber }}>{nameOnly}</strong> name only</span>}
                {emailOnly > 0 && <span><strong style={{ color: C.mid  }}>{emailOnly}</strong> email only</span>}
              </div>
              <div style={{ fontSize:11, color: C.muted, marginTop:4 }}>Click to change</div>
            </>
          ) : (
            <>
              <div style={{ fontSize:14, color: C.mid }}>
                Drop a <strong style={{ color: C.text }}>.txt</strong>, <strong style={{ color: C.text }}>.csv</strong> or <strong style={{ color: C.text }}>.tsv</strong> file here, or click to browse
              </div>
              <div style={{ fontSize:12, color: C.muted, marginTop:6 }}>
                One contact per line — email, name, or both
              </div>
            </>
          )}
        </div>

        {/* ── Network selector ── */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: C.dim, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 8 }}>
            Search on
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {NETWORKS.map(n => {
              const active = selectedNetworks.includes(n.id);
              return (
                <button
                  key={n.id}
                  onClick={() => toggleNetwork(n.id)}
                  style={{
                    background: active ? C.purple + "22" : "transparent",
                    border: `1px solid ${active ? C.purple : C.muted}`,
                    color: active ? "#a5b4fc" : C.dim,
                    borderRadius: 6, padding: "4px 12px",
                    fontSize: 12, cursor: "pointer", transition: "all 0.15s",
                  }}
                >
                  {n.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Global error ── */}
        {globalError && (
          <div style={{
            background:"#2d0f0f", border:`1px solid ${C.red}44`,
            borderRadius:8, padding:"12px 16px", marginBottom:16,
            fontSize:13, color: C.red,
          }}>
            ⚠ {globalError}
          </div>
        )}

        {/* ── Preview + Run ── */}
        {contacts.length > 0 && (
          <div style={{ marginBottom:20, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", flex:1 }}>
              {contacts.slice(0, 5).map((c, i) => (
                <span key={i} style={{
                  background: C.border, border:`1px solid ${C.muted}`,
                  borderRadius:4, padding:"3px 10px",
                  fontSize:12, fontFamily:"monospace", color: C.mid,
                }}>
                  {c.name && c.email ? `${c.name} <${c.email}>` : c.name || c.email}
                </span>
              ))}
              {contacts.length > 5 && (
                <span style={{ fontSize:12, color: C.dim, alignSelf:"center" }}>+{contacts.length-5} more</span>
              )}
            </div>
            <button
              onClick={handleRun}
              disabled={processing}
              style={{
                background: processing ? C.border : `linear-gradient(135deg,${C.purple},${C.pink})`,
                color: processing ? C.dim : "white",
                border:"none", borderRadius:8, padding:"10px 26px",
                fontSize:14, fontWeight:600,
                cursor: processing ? "not-allowed" : "pointer",
                whiteSpace:"nowrap", transition:"opacity 0.2s",
              }}
            >
              {processing ? "⏳ Running…" : "▶ Run Enrichment"}
            </button>
          </div>
        )}

        {processing && <ProgressBar value={done} total={contacts.length} />}

        {/* ── Results table ── */}
        {results.length > 0 && (
          <div style={{ marginTop:16, borderRadius:12, overflow:"hidden", border:`1px solid ${C.border}` }}>
            {/* Stats bar */}
            <div style={{
              background: C.surface, borderBottom:`1px solid ${C.border}`,
              padding:"10px 16px", display:"flex", gap:20, fontSize:12, color: C.dim, flexWrap:"wrap",
            }}>
              <span><strong style={{ color: C.text }}>{results.length}</strong> processed</span>
              <span><strong style={{ color: C.green }}>{results.filter(r=>(r.confidence||0)>=0.75).length}</strong> high conf.</span>
              <span><strong style={{ color: C.amber }}>{results.filter(r=>(r.confidence||0)>=0.4&&(r.confidence||0)<0.75).length}</strong> medium</span>
              <span><strong style={{ color: C.red   }}>{results.filter(r=>(r.confidence||0)<0.4).length}</strong> low / not found</span>
              <span style={{ marginLeft:"auto" }}>Click any row to expand</span>
            </div>
            {/* Table */}
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead>
                  <tr style={{ background: C.surface, borderBottom:`2px solid ${C.border}` }}>
                    {["Contact","Industry","Role","Location","Education","Interests","Sources","Conf."].map(h => (
                      <th key={h} style={{
                        padding:"10px 14px", textAlign:"left",
                        fontSize:10, textTransform:"uppercase", letterSpacing:1.2,
                        color: C.muted, fontWeight:600, whiteSpace:"nowrap",
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((row, i) => <ResultRow key={i} row={row} idx={i} />)}
                  {processing && (
                    <tr style={{ background: C.surface }}>
                      <td colSpan={8} style={{ padding:14, textAlign:"center", color: C.muted, fontSize:13 }}>
                        ⏳ Processing {contacts[done]?.name || contacts[done]?.email || "…"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Empty state ── */}
        {!contacts.length && !results.length && (
          <div style={{ textAlign:"center", padding:"80px 0", color: C.muted }}>
            <div style={{ fontSize:52, marginBottom:16 }}>🕵️</div>
            <div style={{ fontSize:15 }}>Upload a contact list to begin</div>
            <div style={{ fontSize:12, marginTop:6 }}>Supports .txt · .csv · .tsv</div>
          </div>
        )}

      </main>

      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #0f172a; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
      `}</style>
    </div>
  );
}
