#!/usr/bin/env npx tsx
/**
 * diag-2captcha-browser.ts — Diagnostic complet de l'intégration 2Captcha Browser API
 *
 * Ce script teste le flux complet :
 *   1. Vérification du statut du compte Browser API
 *   2. Liste des browser accounts existants
 *   3. Connexion au navigateur cloud via CDP WebSocket
 *   4. Résolution du challenge Cloudflare (auto-solve / manual)
 *   5. Extraction cookies (cf_clearance, PHPSESSID)
 *   6. Prefetch /main/ (widget Bookitit)
 *   7. Test de requête HTTP avec les cookies extraits (via impit)
 *
 * PRÉREQUIS :
 *   - TWOCAPTCHA_API_KEY (obligatoire)
 *   - Un des trois modes de connexion :
 *     a) TWOCAPTCHA_CDP_URL (CDP URL complète — le plus simple)
 *     b) TWOCAPTCHA_ACCOUNT_ID (via API /browser/connection)
 *     c) TWOCAPTCHA_BROWSER_LOGIN + TWOCAPTCHA_BROWSER_PASS (construction manuelle)
 *   - Optionnel : proxy Decodo/SOAX (decodo-proxies.csv ou SOAX_PROXY_URL)
 *
 * USAGE :
 *   npx tsx scripts/diag-2captcha-browser.ts
 *   npx tsx scripts/diag-2captcha-browser.ts --portal kinshasa
 *   npx tsx scripts/diag-2captcha-browser.ts --status-only
 */

import "dotenv/config";
import {
  solve2CaptchaBrowserSession,
  check2CaptchaBrowserStatus,
  list2CaptchaBrowserAccounts,
  load2CaptchaConfig,
} from "../src/spain-2captcha-browser.js";
import {
  KINSHASA_PORTAL_URL,
  KINSHASA_WIDGET_KEY,
  SAOPOLO_PORTAL_URL,
  SAOPOLO_WIDGET_KEY,
} from "../src/spain-portals.js";

// ─── Args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const portalArg = args.find((a) => a.startsWith("--portal"))
  ? args[args.indexOf("--portal") + 1] ?? args.find((a) => a.startsWith("--portal="))?.split("=")[1]
  : undefined;
const statusOnly = args.includes("--status-only");
const verbose = args.includes("--verbose") || args.includes("-v");

// ─── Known Portals ──────────────────────────────────────────────────────────

const KNOWN_PORTALS: Array<{ name: string; aliases: string[]; widgetKey: string; url: string }> = [
  { name: "Kinshasa", aliases: ["kinshasa", "congo", "rdc"], widgetKey: KINSHASA_WIDGET_KEY, url: KINSHASA_PORTAL_URL },
  { name: "São Paulo", aliases: ["saopolo", "saopaulo", "bresil", "brazil"], widgetKey: SAOPOLO_WIDGET_KEY, url: SAOPOLO_PORTAL_URL },
];

// ─── Portal Resolver ────────────────────────────────────────────────────────

function resolveTargetUrl(portalName?: string): string {
  const defaultUrl =
    process.env.SPAIN_WIDGET_URL ||
    "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

  if (!portalName) return defaultUrl;

  const needle = portalName.toLowerCase();
  const portal = KNOWN_PORTALS.find(
    (p) =>
      p.name.toLowerCase().includes(needle) ||
      p.aliases.some((a) => a.includes(needle)) ||
      p.widgetKey.toLowerCase().includes(needle),
  );

  if (portal) {
    console.log(`📍 Portail trouvé: ${portal.name}`);
    return portal.url;
  }

  console.warn(`⚠️ Portail "${portalName}" non trouvé — utilisation URL par défaut`);
  return defaultUrl;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🔬 Diagnostic 2Captcha Browser API — VisaFlow 2026");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ── Étape 1: Vérifier la config ─────────────────────────────────────────
  console.log("── Étape 1: Configuration ──────────────────────────────────\n");

  const config = load2CaptchaConfig();
  if (!config) {
    console.error("❌ TWOCAPTCHA_API_KEY non définie — impossible de continuer");
    console.error("   Définir : export TWOCAPTCHA_API_KEY=votre_clé_api");
    process.exit(1);
  }

  console.log(`✅ API Key: ${config.apiKey.slice(0, 8)}…${config.apiKey.slice(-4)}`);
  console.log(`   Account ID: ${config.accountId ?? "non défini"}`);
  console.log(`   Browser Login: ${config.browserLogin ?? "non défini"}`);
  console.log(`   Profile ID: ${config.profileId ?? "Default"}`);
  console.log(`   Country: ${config.country}`);
  console.log(`   CDP URL: ${config.cdpUrl ? "✅ définie" : "❌ non définie"}`);
  console.log(
    `   Custom Proxy: ${config.customProxy ? `✅ ${config.customProxy.type}://${config.customProxy.host}:${config.customProxy.port}` : "❌ aucun"}`,
  );

  const hasConnectionMethod = config.cdpUrl || config.accountId || (config.browserLogin && config.browserPassword);
  if (!hasConnectionMethod) {
    console.error("\n❌ Aucune méthode de connexion configurée !");
    console.error("   Options :");
    console.error("   a) TWOCAPTCHA_CDP_URL=ws://...  (le plus simple)");
    console.error("   b) TWOCAPTCHA_ACCOUNT_ID=123");
    console.error("   c) TWOCAPTCHA_BROWSER_LOGIN=xxx + TWOCAPTCHA_BROWSER_PASS=yyy");
    if (!statusOnly) process.exit(1);
  }

  // ── Étape 2: Statut du compte ───────────────────────────────────────────
  console.log("\n── Étape 2: Statut du compte Browser API ──────────────────\n");

  const status = await check2CaptchaBrowserStatus();
  if (status.ok) {
    console.log("✅ Compte Browser API actif");
    if (status.trafficGb) {
      const pct = status.trafficGb.total > 0
        ? ((status.trafficGb.used / status.trafficGb.total) * 100).toFixed(1)
        : "0";
      console.log(
        `   Traffic: ${status.trafficGb.used}GB / ${status.trafficGb.total}GB utilisé (${pct}%)` +
        ` — ${status.trafficGb.available}GB restant`,
      );
    }
    if (status.accounts) {
      console.log(`   Accounts: ${status.accounts.count} / ${status.accounts.max}`);
    }
  } else {
    console.error(`❌ Statut compte: ${status.error}`);
    if (statusOnly) process.exit(1);
  }

  // ── Étape 3: Liste des browser accounts ─────────────────────────────────
  console.log("\n── Étape 3: Browser Accounts ───────────────────────────────\n");

  const accountsList = await list2CaptchaBrowserAccounts();
  if (accountsList.ok && accountsList.accounts) {
    if (accountsList.accounts.length === 0) {
      console.log("ℹ️  Aucun browser account trouvé");
      console.log("   Créer un account via le Dashboard 2Captcha ou via l'API");
    } else {
      console.log(`✅ ${accountsList.accounts.length} browser account(s) trouvé(s):`);
      for (const acc of accountsList.accounts) {
        console.log(`   • id=${acc.id} | "${acc.name}" | proxy=${acc.proxyMode} | profiles=${acc.profilesCount}`);
        if (verbose && acc.connectionUri) {
          const masked = acc.connectionUri.replace(/:([^:@]{3})[^:@]*@/, ":$1***@");
          console.log(`     CDP: ${masked}`);
        }
      }
    }
  } else {
    console.warn(`⚠️ Liste accounts: ${accountsList.error}`);
  }

  if (statusOnly) {
    console.log("\n✅ Diagnostic statut terminé (--status-only)");
    return;
  }

  // ── Étape 4: Test de connexion + résolution CF ──────────────────────────
  console.log("\n── Étape 4: Connexion + Résolution Challenge CF ────────────\n");

  const targetUrl = resolveTargetUrl(portalArg);
  console.log(`🎯 URL cible: ${targetUrl}\n`);

  const t0 = Date.now();
  const result = await solve2CaptchaBrowserSession(targetUrl);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n── Résultat (${elapsed}s) ─────────────────────────────────\n`);

  if (result.success && result.session) {
    console.log("✅ Session 2Captcha Browser établie avec succès !");
    console.log(`   Résolu par: ${result.solvedBy}`);
    console.log(`   Durée: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`   cf_clearance: ${result.session.cfClearance ? result.session.cfClearance.slice(0, 30) + "…" : "❌ absent"}`);
    console.log(`   PHPSESSID: ${result.session.allCookies.find((c) => c.name === "PHPSESSID")?.value.slice(0, 15) ?? "❌ absent"}`);
    console.log(`   User-Agent: ${result.session.userAgent.slice(0, 60)}…`);
    console.log(`   Proxy: ${result.session.soaxProxyUrl || "aucun"}`);
    console.log(`   Cookies total: ${result.session.allCookies.length}`);
    console.log(`   Prefetch /main/: ${result.session.prefetchedMainHtml ? `✅ ${result.session.prefetchedMainHtml.length}B` : "❌"}`);
    console.log(`   Expire dans: ${Math.round((result.session.expiresAt - Date.now()) / 60_000)}min`);

    if (verbose) {
      console.log("\n   Tous les cookies:");
      for (const c of result.session.allCookies) {
        console.log(`     ${c.name}: ${c.value.slice(0, 40)}${c.value.length > 40 ? "…" : ""}`);
      }
    }

    // ── Étape 5: Test requête HTTP avec cookies ─────────────────────────
    console.log("\n── Étape 5: Test requête HTTP (impit) avec cookies ────────\n");

    try {
      const { Impit } = await import("impit");
      const impit = new Impit({
        browser: "chrome",
        proxy: result.session.soaxProxyUrl || undefined,
      });

      const cookieHeader = result.session.allCookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      const testUrl = targetUrl;
      console.log(`🌐 GET ${testUrl}`);

      const resp = await impit.fetch(testUrl, {
        headers: {
          "User-Agent": result.session.userAgent,
          Cookie: cookieHeader,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
          Referer: "https://www.citaconsular.es/",
        },
        redirect: "follow",
      });

      const body = await resp.text();
      console.log(`   Status: ${resp.status}`);
      console.log(`   Body: ${body.length}B`);
      console.log(`   Titre: ${body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "N/A"}`);

      if (resp.status === 200 && body.length > 200) {
        console.log("   ✅ Requête HTTP réussie — les cookies sont valides !");
      } else if (resp.status === 403) {
        console.warn("   ⚠️ 403 Forbidden — cf_clearance non accepté (IP ou TLS mismatch ?)");
      } else if (body.length === 0) {
        console.warn("   ⚠️ 0B body — le serveur rejette la requête");
      } else {
        console.warn(`   ⚠️ Réponse inattendue (${resp.status}, ${body.length}B)`);
      }

      impit.close();
    } catch (e: any) {
      console.warn(`⚠️ Test HTTP échoué: ${e.message}`);
      console.log("   (Ceci est normal si impit n'est pas configuré ou si le proxy n'est pas disponible)");
    }
  } else {
    console.error("❌ Échec de la session 2Captcha Browser");
    console.error(`   Erreur: ${result.error}`);
    console.error(`   Durée: ${(result.durationMs / 1000).toFixed(1)}s`);
    process.exit(1);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  ✅ Diagnostic terminé");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("💥 Erreur fatale:", err);
  process.exit(1);
});
