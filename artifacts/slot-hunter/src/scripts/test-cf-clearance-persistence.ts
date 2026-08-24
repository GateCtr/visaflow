/**
 * test-cf-clearance-persistence.ts — Teste si la cf_clearance survit à plusieurs GET widget
 *
 * Objectif : vérifier que après un solve CF initial, les GET widget suivants
 * passent sans challenge (HTTP 200 + token visible dans le HTML).
 *
 * Si le test montre que le 2ème GET widget trigger un challenge → le problème
 * est dans la réinjection du cookie ou dans Cloudflare qui invalide la clearance.
 *
 * Usage : npx tsx src/scripts/test-cf-clearance-persistence.ts
 */

import "dotenv/config";
import { Impit } from "impit";
import { initWorkerSession, type SpainCfSession } from "../spain-soax-solver.js";
import { initDecodoPool, rotateDecodoUrl } from "../spain-decodo-pool.js";

const PORTAL_URL = process.env.SPAIN_TEST_PORTAL_URL
  ?? "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";

async function main(): Promise<void> {
  const capsolverKey = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
  if (!capsolverKey) {
    console.error("❌ CAPSOLVER_API_KEY manquante");
    process.exit(1);
  }

  // 1. Init proxy
  await initDecodoPool();
  const proxyUrl = rotateDecodoUrl();
  if (!proxyUrl) {
    console.error("❌ Aucun proxy Decodo disponible");
    process.exit(1);
  }

  // Ajouter sticky session pour stabiliser l'exit IP
  const stickyId = Math.random().toString(36).slice(2, 10);
  const stickyProxy = addSticky(proxyUrl, stickyId);
  console.log(`\n📡 Proxy: ${stickyProxy.replace(/:([^:@]+)@/, ":***@").slice(0, 60)}…`);
  console.log(`🎯 Portal: ${PORTAL_URL.slice(-50)}`);

  // 2. Solve CF initial
  console.log(`\n── PHASE 1 : Solve CF initial ──`);
  const t0 = Date.now();
  const result = await initWorkerSession(stickyProxy, PORTAL_URL, capsolverKey);
  if (!result) {
    console.error("❌ Solve initial échoué");
    process.exit(1);
  }
  const solveMs = Date.now() - t0;
  const session = result.session;
  console.log(`✅ Solve OK (${(solveMs / 1000).toFixed(1)}s)`);
  console.log(`   cf_clearance: ${session.cfClearance.slice(0, 30)}…`);
  console.log(`   UA: ${session.userAgent.slice(0, 50)}…`);
  console.log(`   Cookies: ${session.allCookies.map(c => c.name).join(", ")}`);

  // 3. Tester N GET widget successifs avec le MÊME impit + MÊME cf_clearance
  console.log(`\n── PHASE 2 : GET widget répétés (même clearance, même impit) ──`);

  const impit = session._ownImpit;
  if (!impit) {
    console.error("❌ _ownImpit absent dans la session");
    process.exit(1);
  }

  const buildCookieStr = (cookies: Array<{ name: string; value: string }>): string =>
    cookies.filter(c => c.value).map(c => `${c.name}=${c.value}`).join("; ");

  const NUM_ATTEMPTS = 5;
  const DELAY_BETWEEN = 5_000; // 5s entre chaque GET

  for (let i = 1; i <= NUM_ATTEMPTS; i++) {
    if (i > 1) {
      console.log(`   ⏳ Attente ${DELAY_BETWEEN / 1000}s…`);
      await new Promise(r => setTimeout(r, DELAY_BETWEEN));
    }

    const t1 = Date.now();
    try {
      const cookieStr = buildCookieStr(session.allCookies);
      console.log(`\n   [${i}/${NUM_ATTEMPTS}] GET widget — Cookie: ${cookieStr.slice(0, 80)}…`);

      const r = await (impit.fetch(PORTAL_URL, {
        headers: {
          "User-Agent": session.userAgent,
          "Cookie": cookieStr,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        },
      } as any) as unknown as Promise<Response>);

      const body = await r.text();
      const elapsed = Date.now() - t1;
      const isCf = r.status === 403 || /just a moment|_cf_chl_opt/i.test(body.slice(0, 3000));
      const hasToken = /name="token"\s+value="[^"]+"/i.test(body);

      if (isCf) {
        console.log(`   ❌ [${i}] CF CHALLENGE (HTTP ${r.status}, ${body.length}B, ${elapsed}ms)`);
        console.log(`      → La clearance est INVALIDÉE après ${i - 1} requête(s) réussies`);
        console.log(`      → Headers response: ${JSON.stringify(Object.fromEntries([...new Map(r.headers as any)].slice(0, 5)))}`);
        // Essayer de voir si le Set-Cookie change
        const setCookie = r.headers.get("set-cookie") ?? "";
        if (setCookie) console.log(`      → Set-Cookie: ${setCookie.slice(0, 100)}…`);
        break;
      } else if (hasToken) {
        console.log(`   ✅ [${i}] HTTP ${r.status} — token présent (${body.length}B, ${elapsed}ms)`);
        // Extraire et afficher le nouveau cf_clearance si changé
        const newClearance = body.match(/cf_clearance=([^;]+)/)?.[1];
        if (newClearance && newClearance !== session.cfClearance) {
          console.log(`      ⚠️ cf_clearance a CHANGÉ : ${newClearance.slice(0, 20)}…`);
        }
      } else {
        console.log(`   ⚠️ [${i}] HTTP ${r.status} — PAS de token (${body.length}B, ${elapsed}ms)`);
        console.log(`      Body (500c): ${body.slice(0, 500)}`);
      }
    } catch (e) {
      console.log(`   ❌ [${i}] Erreur réseau: ${e}`);
    }
  }

  // 4. Tester avec un NOUVEAU impit (même proxy, même clearance) — simule refreshSessionAndScan
  console.log(`\n── PHASE 3 : Nouveau impit (même proxy + même clearance) ──`);
  console.log(`   Simule ce que fait refreshSessionAndScan : nouvel impit, réinjecte cf_clearance`);

  const impit2 = new Impit({ browser: "chrome", proxyUrl: stickyProxy, timeout: 30_000 } as any);
  try {
    const cookieStr = buildCookieStr(session.allCookies);
    const r = await (impit2.fetch(PORTAL_URL, {
      headers: {
        "User-Agent": session.userAgent,
        "Cookie": cookieStr,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      },
    } as any) as unknown as Promise<Response>);

    const body = await r.text();
    const isCf = r.status === 403 || /just a moment|_cf_chl_opt/i.test(body.slice(0, 3000));
    const hasToken = /name="token"\s+value="[^"]+"/i.test(body);

    if (isCf) {
      console.log(`   ❌ Nouveau impit → CF CHALLENGE (HTTP ${r.status}, ${body.length}B)`);
      console.log(`      → Le cf_clearance est lié à l'instance impit (TLS fingerprint)`);
      console.log(`      → refreshSessionAndScan ne peut PAS réutiliser un cf_clearance cross-impit`);
    } else if (hasToken) {
      console.log(`   ✅ Nouveau impit → OK (HTTP ${r.status}, token présent, ${body.length}B)`);
      console.log(`      → Le cf_clearance N'EST PAS lié à l'instance impit — transferable`);
    } else {
      console.log(`   ⚠️ Nouveau impit → HTTP ${r.status} (${body.length}B) — pas de token`);
      console.log(`      Body (500c): ${body.slice(0, 500)}`);
    }
  } catch (e) {
    console.log(`   ❌ Erreur réseau: ${e}`);
  }

  console.log(`\n── RÉSUMÉ ──`);
  console.log(`Si Phase 2 échoue au 2ème GET : le cf_clearance expire après 1 utilisation (single-use)`);
  console.log(`Si Phase 2 OK mais Phase 3 échoue : la clearance est liée au TLS fingerprint de l'impit`);
  console.log(`Si tout OK : le problème est ailleurs (timing, cookies manquants, etc.)`);

  process.exit(0);
}

function addSticky(url: string, sid: string): string {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    const stickyUser = user.includes("-session-")
      ? user.replace(/-session-[^-]+/, `-session-${sid}`)
      : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${sid}$2`);
    u.username = encodeURIComponent(stickyUser);
    return u.toString();
  } catch { return url; }
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  process.exit(1);
});
