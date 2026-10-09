/**
 * debug-go-tls-aligned.ts — Test HTTP-pur : CapSolver + serveur Go uTLS avec empreinte TLS
 * ALIGNÉE sur la version Chrome EXACTE que CapSolver utilise (UA = Chrome/151).
 *
 * C'est la variable que les tests précédents n'avaient pas contrôlée : le profil Go était
 * chrome_131/133 alors que CapSolver résout avec Chrome/151. La doc CapSolver dit que tout
 * décalage navigateur/TLS → rejet immédiat du cf_clearance.
 *
 * Flux par IP :
 *   1. GET portail São Paulo via Go (TLS Chrome aligné) → HTML challenge "Just a moment"
 *   2. CapSolver AntiCloudflareTask (même proxy + même UA + html) → cf_clearance
 *   3. GET post-clearance via Go (même TLS/proxy/UA + cookies) → token + PHPSESSID ?
 *
 * PASS = le GET2 n'est plus un challenge CF ET contient un token OU un Set-Cookie PHPSESSID.
 */
import "dotenv/config";
import { solveSpainCloudflare } from "../spain-soax-solver.js";
import { getDecodoProxyForIndex, getDecodoPoolSize } from "../spain-decodo-pool.js";

const URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const GO = process.env.TLS_PROXY_URL ?? "http://127.0.0.1:8787";
const N = Number(process.env.SWEEP_N ?? 5);
const START = Number(process.env.START_INDEX ?? 8888);

// UA EXACT utilisé par WORKER_UA / renvoyé par CapSolver = Chrome/151.
const UA151 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

// Profils Go triés du PLUS PROCHE de 151 au plus éloigné (contrôles).
const PROFILES: Array<{ profile: string; ua: string }> = [
  { profile: "chrome_152", ua: UA151 }, // le plus proche de 151 disponible dans tls-client
  { profile: "chrome_150", ua: UA151 },
  { profile: "chrome_146", ua: UA151 },
];

function addSticky(url: string, sid: string): string {
  // Decodo: user-Visaflow-sessionduration-60 → user-Visaflow-session-{sid}-sessionduration-60
  return url.replace(/-sessionduration-/, `-session-${sid}-sessionduration-`);
}

async function goFetch(url: string, proxy: string, ua: string, profile: string, cookie = "") {
  const r = await fetch(`${GO}/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, proxy, userAgent: ua, profile, cookie }),
  });
  return r.json() as Promise<{ status: number; body: string; setCookie: string[]; cfRay: string; error?: string }>;
}

function hasToken(b: string) { return /name="token"\s+value="([^"]+)"/i.test(b) || /bkt_init_widget/i.test(b); }
function isCf(b: string) { return /just a moment|_cf_chl_opt|cf-mitigated/i.test(b.slice(0, 4000)); }
function phpSessid(sc: string[]) { return (sc ?? []).some((l) => /PHPSESSID=/i.test(l)); }
function jarFrom(sc: string[]): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const line of sc ?? []) {
    const m = line.match(/^([^=]+)=([^;]+)/);
    if (m) jar[m[1].trim()] = m[2].trim();
  }
  return jar;
}

async function main() {
  const KEY = (process.env.CAPSOLVER_API_KEY ?? "").trim();
  if (!KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }
  const size = getDecodoPoolSize();
  if (size === 0) { console.error("❌ pool Decodo vide"); process.exit(1); }
  console.log(`Pool=${size} | URL São Paulo | UA=Chrome/151 | START=${START} | N=${N}/profil\n`);

  const summary: Array<{ profile: string; pass: number; cfSolved: number }> = [];

  for (const prof of PROFILES) {
    let pass = 0, cfSolved = 0;
    console.log(`\n═══ Profil Go TLS=${prof.profile}  (UA Chrome/151) ═══`);
    for (let i = 0; i < N; i++) {
      const base = getDecodoProxyForIndex((START + i) % size) ?? "";
      const sid = Math.random().toString(36).slice(2, 10);
      const proxy = addSticky(base, sid);
      const portLabel = (base.match(/:(\d+)$/) ?? [])[1] ?? "?";

      try {
        const r1 = await goFetch(URL, proxy, prof.ua, prof.profile);
        if (r1.error) { console.log(`  #${i + 1} port${portLabel} go-err: ${r1.error.slice(0, 60)}`); continue; }

        // Si le GET1 passe directement (pas de challenge) → jackpot IP de confiance
        if (r1.status === 200 && !isCf(r1.body)) {
          const direct = hasToken(r1.body) || phpSessid(r1.setCookie);
          console.log(`  #${i + 1} port${portLabel} GET1=200 ${r1.body.length}B SANS challenge token=${direct ? "✅" : "?"}`);
          if (direct) pass++;
          continue;
        }

        const jar = jarFrom(r1.setCookie);
        const res = await solveSpainCloudflare(URL, KEY, proxy, r1.body, prof.ua);
        if (!res.success || !res.session) { console.log(`  #${i + 1} port${portLabel} ❌ solve: ${res.error}`); continue; }
        cfSolved++;
        for (const c of res.session.allCookies ?? []) jar[c.name] = c.value;

        const cookieStr = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
        const r2 = await goFetch(URL, proxy, prof.ua, prof.profile, cookieStr);
        const stillCf = isCf(r2.body);
        const got = (!stillCf && r2.status === 200) && (hasToken(r2.body) || phpSessid(r2.setCookie));
        if (got) pass++;
        console.log(
          `  #${i + 1} port${portLabel} clr=${res.session.cfClearance?.length}B | GET2=${r2.status} ${r2.body.length}B ` +
          `encoreCF=${stillCf ? "OUI" : "non"} token=${hasToken(r2.body) ? "✅" : "✗"} PHPSESSID=${phpSessid(r2.setCookie) ? "✅" : "✗"} → ${got ? "🎉 PASS" : "❌"}`
        );
      } catch (e) {
        console.log(`  #${i + 1} port${portLabel} ERREUR: ${e instanceof Error ? e.message.slice(0, 70) : e}`);
      }
    }
    console.log(`  → ${prof.profile}: ${pass}/${N} PASS (CF résolu ${cfSolved}/${N})`);
    summary.push({ profile: prof.profile, pass, cfSolved });
  }

  console.log("\n╔══════════════ RÉSUMÉ ══════════════╗");
  for (const s of summary) console.log(`  ${s.profile.padEnd(12)} → ${s.pass}/${N} PASS | CF solved ${s.cfSolved}/${N}`);
  console.log("╚════════════════════════════════════╝");
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
