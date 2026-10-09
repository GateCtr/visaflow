/**
 * debug-go-tls-capsolver.ts — Flux CapSolver + serveur Go uTLS (empreinte Chrome exacte).
 *
 * Reproduit l'archi recommandée par CapSolver :
 *   1. GET initial VIA le serveur Go (TLS Chrome réel) → HTML challenge "Just a moment"
 *   2. CapSolver AntiCloudflareTask (même proxy + UA) → cf_clearance
 *   3. GET post-clearance VIA le serveur Go avec le cf_clearance → token+PHPSESSID ?
 *
 * Si le GET #3 passe (token ✅) là où impit échoue → l'empreinte TLS Go est la solution.
 */
import "dotenv/config";
import { solveSpainCloudflare } from "../spain-soax-solver.js";
import { getDecodoProxyForIndex, getDecodoPoolSize } from "../spain-decodo-pool.js";

const URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const GO = process.env.TLS_PROXY_URL ?? "http://127.0.0.1:8787";
const N = Number(process.env.SWEEP_N ?? 6);
// Profils Go à tester + UA assorti exact
const PROFILES = [
  { profile: "chrome_133", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36" },
  { profile: "chrome_131", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
];

async function goFetch(url: string, proxy: string, ua: string, profile: string, cookie = "") {
  const r = await fetch(`${GO}/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, proxy, userAgent: ua, profile, cookie }),
  });
  return r.json() as Promise<{ status: number; body: string; setCookie: string[]; cfRay: string; error?: string }>;
}

function hasToken(b: string) { return /name="token"\s+value="([^"]+)"/i.test(b); }
function isCf(b: string) { return /just a moment|_cf_chl_opt/i.test(b.slice(0, 3000)); }
function cookieFromSetCookie(sc: string[]): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const line of sc ?? []) {
    const m = line.match(/^([^=]+)=([^;]+)/);
    if (m) jar[m[1].trim()] = m[2].trim();
  }
  return jar;
}

async function main() {
  const KEY = process.env.CAPSOLVER_API_KEY ?? "";
  if (!KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }
  const size = getDecodoPoolSize();

  for (const prof of PROFILES) {
    let ok = 0;
    console.log(`\n═══ Profil Go TLS=${prof.profile} ═══`);
    for (let i = 0; i < N; i++) {
      let proxy = getDecodoProxyForIndex(Math.floor(Math.random() * size)) ?? "";
      const fresh = 5000 + Math.floor(Math.random() * 4000);
      proxy = proxy.replace(/EScz8ic9if97ji\d+/, `EScz8ic9if97ji${fresh}`);

      try {
        // 1. GET initial via Go
        const r1 = await goFetch(URL, proxy, prof.ua, prof.profile);
        if (r1.error) { console.log(`  #${i+1} go err: ${r1.error}`); continue; }
        if (r1.status !== 403 && !isCf(r1.body)) {
          console.log(`  #${i+1} GET1 ${r1.status} ${r1.body.length}B token=${hasToken(r1.body) ? "✅ (pas de challenge!)" : "?"}`);
          if (hasToken(r1.body)) ok++;
          continue;
        }
        const jar = cookieFromSetCookie(r1.setCookie);

        // 2. CapSolver avec le HTML challenge + même proxy + même UA
        const res = await solveSpainCloudflare(URL, KEY, proxy, r1.body, prof.ua);
        if (!res.success || !res.session) { console.log(`  #${i+1} ❌ solve: ${res.error}`); continue; }
        for (const c of res.session.allCookies ?? []) jar[c.name] = c.value;

        // 3. GET post-clearance via Go (même TLS, même proxy, même UA)
        const cookieStr = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
        const r2 = await goFetch(URL, proxy, prof.ua, prof.profile, cookieStr);
        const pass = hasToken(r2.body);
        if (pass) ok++;
        console.log(`  #${i+1} sid=${fresh} clrLen=${res.session.cfClearance?.length} | GET2=${r2.status} ${r2.body.length}B token=${pass ? "✅ PASS" : "❌"} encoreCF=${isCf(r2.body) ? "OUI" : "non"} cf-ray=${r2.cfRay}`);
      } catch (e) {
        console.log(`  #${i+1} ERREUR: ${e instanceof Error ? e.message.slice(0,70) : e}`);
      }
    }
    console.log(`  → ${ok}/${N} PASS pour ${prof.profile}`);
  }
  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
