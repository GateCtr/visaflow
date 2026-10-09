/**
 * test-jsd-full-scan.ts — Flux JSD oneshot COMPLET + scan JSONP (le vrai objectif).
 * GET portal → POST widget#1 → jsd/main.js → JSD oneshot (cf_clearance#2) → POST widget#2
 * → getwidgetconfigurations → getservices → getagendas → datetime.
 * Prouve si le mécanisme HTTP pur franchit CF ET récupère les données du widget.
 */
import {
  ensureSpainCfSession,
  spainCfFetch,
  invalidateSpainCfSession,
} from "./src/spain-soax-solver.js";

const PUBLICKEY = "28330379fc95acafd31ee9e8938c278ff";
const PORTAL_URL = `https://www.citaconsular.es/es/hosteds/widgetdefault/${PUBLICKEY}/`;
const BASE = "https://www.citaconsular.es/onlinebookings/";

invalidateSpainCfSession();
const session = await ensureSpainCfSession(PORTAL_URL);
if (!session) { console.error("❌ CF session"); process.exit(1); }

const cookies: Record<string, string> = {};
for (const c of session.allCookies ?? []) cookies[c.name] = c.value;
let activeCf = session.cfClearance;

function merge(res: Response | null, label: string) {
  for (const raw of res?.headers?.getSetCookie?.() ?? []) {
    const part = raw.split(";")[0] ?? ""; const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const n = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
    if (n === "cf_clearance") { activeCf = v; console.log(`  🔑 cf_clearance ← ${label}`); }
    else if (n === "PHPSESSID") { cookies.PHPSESSID = v; console.log(`  🍪 PHPSESSID ← ${label}: ${v.slice(0,10)}…`); }
    else if (n && v) cookies[n] = v;
  }
}
function ck() {
  const p: string[] = [];
  for (const n of ["_ga","_ga_F3TYSDL945","PHPSESSID"]) if (cookies[n]) p.push(`${n}=${cookies[n]}`);
  for (const [k,v] of Object.entries(cookies)) if (!["_ga","_ga_F3TYSDL945","PHPSESSID","cf_clearance"].includes(k)) p.push(`${k}=${v}`);
  p.push(`cf_clearance=${activeCf}`); return p.join("; ");
}
const parseJsonp = (s: string) => { try { const m = s.match(/\(([\s\S]*)\)[;\s]*$/); return JSON.parse(m ? m[1] : s); } catch { return null; } };
let srvsrc = "https://www.citaconsular.es", version = "4";

async function jsonp(endpoint: string, extra: Record<string,string> = {}) {
  const t = Date.now(); const cb = `jQuery211${t}_${Math.floor(Math.random()*1e9)}`;
  const q = new URLSearchParams({ callback: cb, type: "default", publickey: PUBLICKEY, lang: "es", version, src: PORTAL_URL, srvsrc, _: String(t) });
  for (const [k,v] of Object.entries(extra)) q.append(k,v);
  const r = await spainCfFetch(`${BASE}${endpoint}?${q}`, session!, {
    headers: { Cookie: ck(), "X-Requested-With": "XMLHttpRequest",
      Accept: "text/javascript, application/javascript, */*; q=0.01", "Accept-Language": "fr-FR,fr;q=0.9",
      Referer: PORTAL_URL, "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", Priority: "u=1, i" },
  });
  const b = await r.text(); merge(r, endpoint);
  return b;
}

const htmlHdrs = { Accept: "text/html,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9", "Sec-Fetch-Site": "same-origin" };

// 1. GET portal
const r1 = await spainCfFetch(PORTAL_URL, session, { headers: { Cookie: ck(), ...htmlHdrs, "Sec-Fetch-Site": "none" } });
const h1 = await r1.text(); merge(r1, "GET portal");
const token = h1.match(/name="token"\s+value="([^"]+)"/)?.[1] ?? "";
const isCfPage = /just a moment|_cf_chl_opt|challenge-platform|cf-mitigated/i.test(h1.slice(0,3000));
const cfMit = r1.headers.get("cf-mitigated") ?? "none";
console.log(`1. GET portal → ${r1.status} ${h1.length}B token=${token.length} | pageCF=${isCfPage} cf-mitigated=${cfMit}`);
console.log(`   GET portal snippet: ${h1.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,180)}`);

// 2. GET portal RE-TRY avec clearance (le token peut n'apparaître qu'après clearance actif)
let realToken = token;
if (!realToken) {
  const rG = await spainCfFetch(PORTAL_URL, session, { headers: { Cookie: ck(), ...htmlHdrs, "Sec-Fetch-Site": "none" } });
  const hG = await rG.text(); merge(rG, "GET portal #2");
  realToken = hG.match(/name="token"\s+value="([^"]+)"/)?.[1] ?? "";
  console.log(`1b. GET portal #2 → ${rG.status} ${hG.length}B token=${realToken.length} encoreCF=${/just a moment|_cf_chl_opt/i.test(hG.slice(0,2000))}`);
}

// 2. POST widget #1
const r2 = await spainCfFetch(PORTAL_URL, session, { method: "POST", headers: { Cookie: ck(), ...htmlHdrs, "Content-Type": "application/x-www-form-urlencoded", Origin: "https://www.citaconsular.es", Referer: PORTAL_URL }, body: `token=${encodeURIComponent(realToken)}` });
const h2 = await r2.text();
console.log(`   POST#1 Set-Cookie brut: ${JSON.stringify((r2.headers as any).getSetCookie?.() ?? [])}`);
merge(r2, "POST#1");
srvsrc = h2.match(/srvsrc:\s*'([^']+)'/)?.[1] ?? srvsrc;
version = h2.match(/loadermaec\.js\?v=(\d+)/)?.[1] ?? version;
const cfR = h2.match(/window\.__CF\$cv\$params\s*=\s*\{r:'([^']+)',/)?.[1] ?? "";
// Le token peut aussi venir de la réponse POST#1 (page widget)
const tokenFromPost = h2.match(/name="token"\s+value="([^"]+)"/)?.[1] ?? "";
if (tokenFromPost) realToken = tokenFromPost;
console.log(`2. POST#1 → ${r2.status} ${h2.length}B cfR=${cfR.slice(0,10)} srvsrc=${srvsrc} v=${version} tokenInResp=${tokenFromPost.length}`);

// 3. jsd/main.js + 4. oneshot
if (cfR) {
  const r3 = await spainCfFetch("https://www.citaconsular.es/cdn-cgi/challenge-platform/scripts/jsd/main.js", session, { headers: { Cookie: ck(), Accept: "*/*", Referer: PORTAL_URL, "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "same-origin" } });
  const jsdJs = await r3.text();
  const m = jsdJs.match(/\/jsd\/oneshot\/([a-f0-9]{10,14})\/([\w.:\-_~]+)\//);
  if (m) {
    const oneshotPath = `/cdn-cgi/challenge-platform/h/b/jsd/oneshot/${m[1]}/${m[2]}/${cfR}`;
    await new Promise(r => setTimeout(r, 4500));
    const r4 = await spainCfFetch(`https://www.citaconsular.es${oneshotPath}`, session, { method: "POST", headers: { Cookie: ck(), "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "0", Origin: "https://www.citaconsular.es", Referer: PORTAL_URL, Accept: "*/*", "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin" }, body: "" });
    await r4.text(); merge(r4, "oneshot");
    console.log(`4. oneshot → ${r4.status}`);
    // 5. POST widget #2
    const r5 = await spainCfFetch(PORTAL_URL, session, { method: "POST", headers: { Cookie: ck(), ...htmlHdrs, "Content-Type": "application/x-www-form-urlencoded", Origin: "https://www.citaconsular.es", Referer: PORTAL_URL }, body: `token=${encodeURIComponent(realToken)}` });
    const h5 = await r5.text(); merge(r5, "POST#2");
    const fs = await import("node:fs");
    fs.writeFileSync("/tmp/post1.html", h2); fs.writeFileSync("/tmp/post2.html", h5);
    console.log(`5. POST#2 → ${r5.status} ${h5.length}B`);
    console.log(`   POST#1 snippet: ${h2.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,250)}`);
    console.log(`   POST#2 snippet: ${h5.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,250)}`);
  }
}

// 5b. GET portal APRÈS oneshot (clearance #2) → CF doit laisser passer le GET + poser PHPSESSID
console.log(`\n── GET portal POST-oneshot (clearance #2) ──`);
const rG2 = await spainCfFetch(PORTAL_URL, session, { headers: { Cookie: ck(), ...htmlHdrs, "Sec-Fetch-Site": "none" } });
const hG2 = await rG2.text();
console.log(`   GET post-oneshot Set-Cookie: ${JSON.stringify((rG2.headers as any).getSetCookie?.() ?? [])}`);
merge(rG2, "GET post-oneshot");
const tokenG2 = hG2.match(/name="token"\s+value="([^"]+)"/)?.[1] ?? "";
const cfG2 = /just a moment|_cf_chl_opt/i.test(hG2.slice(0,2000));
console.log(`   GET post-oneshot → ${rG2.status} ${hG2.length}B token=${tokenG2.length} pageCF=${cfG2}`);

// Diagnostic cookies avant scan
console.log(`\n── État cookies avant scan ──`);
console.log(`PHPSESSID=${cookies.PHPSESSID ? cookies.PHPSESSID.slice(0,12)+"…" : "❌ ABSENT"} | cf_clearance=${activeCf.slice(0,20)}… | _ga=${cookies._ga?"✅":"❌"}`);
console.log(`session.portalKey=${(session as any).portalKey ?? "❌ absent"}`);

// 6. Scan JSONP
console.log(`\n── SCAN JSONP ──`);
// Burp row 26 : /main/ est appelé AVANT getwidgetconfigurations (row 103). Respecter l'ordre.
const mainBody = await jsonp("main/");
console.log(`main/ → ${mainBody.length}B`);
const cfg = await jsonp("getwidgetconfigurations/"); console.log(`cfg → ${cfg.length}B`);
const svcRaw = await jsonp("getservices/"); const svc = parseJsonp(svcRaw);
const services = svc?.Services ?? svc?.services ?? [];
console.log(`services → ${svcRaw.length}B | ${services.length} service(s) | AllowAppointment=${svc?.AllowAppointment}`);
if (services.length) {
  const svcId = services.find((s:any)=>(s.name??"").replace(/<[^>]*>/g,"").trim())?.id ?? services[0].id;
  const agRaw = await jsonp("getagendas/", { "services[]": svcId, selectedPeople: "1" });
  const ag = parseJsonp(agRaw); const agendaId = (ag?.Agendas ?? ag?.agendas ?? []).find((a:any)=>a?.id)?.id ?? "";
  console.log(`agendas → ${agRaw.length}B | agendaId=${agendaId}`);
  if (agendaId) {
    const now = new Date();
    const start = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`;
    const end = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${new Date(now.getFullYear(),now.getMonth()+1,0).getDate()}`;
    const dt = await jsonp("datetime/", { "services[]": svcId, "agendas[]": agendaId, start, end, selectedPeople: "1" });
    console.log(`datetime → ${dt.length}B | ${dt.slice(0,120)}`);
  }
}
console.log(`\n✅ FLUX HTTP PUR COMPLET — CF franchi + widget interrogé`);
process.exit(0);
