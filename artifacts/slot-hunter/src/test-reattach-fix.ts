/**
 * test-reattach-fix.ts — Valide le fix "session valide mais _page null → réattachement"
 *
 * Scénario simulé : redémarrage/crash où _cachedSession est encore valide
 * mais le browser a été fermé (_page = null).
 *
 * Avant le fix → ensureSession() court-circuitait sans browser → _page restait null
 *   → callBookititEndpointViaBrowser retournait "" (0B) indéfiniment.
 * Après le fix → ensureSession() détecte _page=null, appelle _reattachBrowserWithSession()
 *   → browser relancé, page initialisée, appels browser fonctionnels.
 *
 * Ce test mocke getOrLaunchBrowser() et createCDPSession() pour ne pas avoir
 * besoin d'un Chromium réel ni d'un proxy — valide uniquement la LOGIQUE de routage.
 */

process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.SPAIN_SESSION_MODE = "persistent-browser";

import { spainPersistentBrowser } from "./_legacy_spain-persistent-browser.js";

let passed = 0;
let failed = 0;

function ok(msg: string)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg: string) { console.error(`  ❌ ${msg}`); failed++; }
function sep(label: string) {
  console.log("\n" + "═".repeat(65));
  console.log(`  ${label}`);
  console.log("═".repeat(65));
}

// ── Mock minimal d'une Page Puppeteer ────────────────────────────────────────
function makeMockPage() {
  // setupPageProxyAuth utilise client.send() ET client.on() via CDP
  const cdpMock = {
    send: async () => {},
    detach: async () => {},
    on: (_event: string, _cb: unknown) => {},   // ← nécessaire pour Fetch.authRequired / Fetch.requestPaused
  };
  return {
    setUserAgent: async () => {},
    setViewport: async () => {},
    setExtraHTTPHeaders: async () => {},
    createCDPSession: async () => cdpMock,
    url: () => "about:blank",
    _isMockPage: true,
  } as any;
}

// ── Mock minimal d'un Browser Puppeteer ─────────────────────────────────────
function makeMockBrowser(page: ReturnType<typeof makeMockPage>) {
  return {
    pages: async () => [page],
    newPage: async () => page,
    close: async () => {},
    _isMockBrowser: true,
  } as any;
}

async function main() {
  sep("TEST 1 — isSessionValid() = true + _page != null → court-circuit immédiat");
  {
    const mgr = spainPersistentBrowser as any;
    const mockPage    = makeMockPage();
    const mockBrowser = makeMockBrowser(mockPage);

    const fakeSession = {
      cfClearance: "fake_A",
      cfDomain: ".citaconsular.es",
      soaxProxyUrl: "",
      userAgent: "Mozilla/5.0 Chrome/148",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60_000,
      allCookies: [{ name: "cf_clearance", value: "fake_A" }],
      extraHeaders: {},
      source: "playwright" as const,
      prefetchedMainHtml: "ok",
    };

    mgr._cachedSession = fakeSession;
    mgr._browser = mockBrowser;
    mgr._page    = mockPage;

    let reattachCalled = false;
    const origReattach = mgr._reattachBrowserWithSession.bind(mgr);
    mgr._reattachBrowserWithSession = async () => { reattachCalled = true; return origReattach(); };

    const result = await spainPersistentBrowser.ensureSession();

    if (!result) fail("ensureSession() a retourné null alors que session+page valides");
    else ok("ensureSession() retourne la session");

    if (reattachCalled) fail("_reattachBrowserWithSession() ne devrait PAS être appelé quand _page est vivant");
    else ok("_reattachBrowserWithSession() NON appelé — court-circuit correct");

    if (result?.cfClearance !== "fake_A") fail("La session retournée n'est pas la session fictive");
    else ok("Session retournée = session fictive originale");

    // Restore
    mgr._reattachBrowserWithSession = origReattach;
    mgr._page    = null;
    mgr._browser = null;
    mgr._cachedSession = null;
  }

  sep("TEST 2 — isSessionValid() = true + _page = null → réattachement déclenché");
  {
    const mgr = spainPersistentBrowser as any;
    const mockPage    = makeMockPage();
    const mockBrowser = makeMockBrowser(mockPage);

    const fakeSession = {
      cfClearance: "fake_B",
      cfDomain: ".citaconsular.es",
      soaxProxyUrl: "",
      userAgent: "Mozilla/5.0 Chrome/148",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60_000,
      allCookies: [{ name: "cf_clearance", value: "fake_B" }],
      extraHeaders: {},
      source: "playwright" as const,
      prefetchedMainHtml: "ok",
    };

    // État post-crash : session valide mais browser null, page null
    mgr._cachedSession = fakeSession;
    mgr._browser = null;
    mgr._page    = null;

    // Remplacer getOrLaunchBrowser par un mock qui retourne le browser fictif
    // (sans lancer de vrai Chromium)
    const origGetOrLaunch = mgr.getOrLaunchBrowser.bind(mgr);
    let launchCalled = false;
    mgr.getOrLaunchBrowser = async (_ua?: string) => {
      launchCalled = true;
      mgr._browser = mockBrowser;
      return mockBrowser;
    };

    console.log("  État initial : _cachedSession=OK, _browser=null, _page=null");
    const result = await spainPersistentBrowser.ensureSession();

    if (!result) fail("ensureSession() a retourné null — réattachement échoué");
    else ok("ensureSession() retourne une session");

    if (!launchCalled) fail("getOrLaunchBrowser() n'a pas été appelé — réattachement non déclenché");
    else ok("getOrLaunchBrowser() appelé — browser relancé");

    const page = spainPersistentBrowser.getActivePage();
    if (!page) fail("getActivePage() retourne toujours null après réattachement");
    else ok("getActivePage() retourne une page — _page correctement initialisé ✨");

    if (result?.cfClearance !== "fake_B") fail("La session retournée ne correspond pas à la session fictive");
    else ok("Session retournée = session fictive originale (pas de re-solve CF)");

    // Restore
    mgr.getOrLaunchBrowser = origGetOrLaunch;
    mgr._page    = null;
    mgr._browser = null;
    mgr._cachedSession = null;
  }

  sep("TEST 3 — isSessionValid() = false → ensureSessionImpl (chemin normal)");
  {
    const mgr = spainPersistentBrowser as any;

    // Session expirée (cas normal → doit aller vers _ensureSessionImpl)
    mgr._cachedSession = {
      cfClearance: "expired",
      cfDomain: ".citaconsular.es",
      soaxProxyUrl: "",
      userAgent: "Mozilla/5.0",
      createdAt: Date.now() - 200 * 60_000,
      expiresAt: Date.now() - 1,   // expirée
      allCookies: [],
      extraHeaders: {},
      source: "playwright" as const,
    };
    mgr._browser = null;
    mgr._page    = null;

    let reattachCalled = false;
    const origReattach = mgr._reattachBrowserWithSession.bind(mgr);
    mgr._reattachBrowserWithSession = async () => { reattachCalled = true; return origReattach(); };

    // On ne veut pas lancer un vrai solve CF — on vérifie juste que le code
    // NE prend PAS le chemin réattachement (il prend _ensureSessionImpl)
    // On mock _ensureSessionImpl pour ne rien faire
    const origImpl = mgr._ensureSessionImpl.bind(mgr);
    let implCalled = false;
    mgr._ensureSessionImpl = async () => { implCalled = true; return null; };

    await spainPersistentBrowser.ensureSession();

    if (reattachCalled) fail("_reattachBrowserWithSession() ne doit PAS être appelé pour une session expirée");
    else ok("_reattachBrowserWithSession() non appelé pour session expirée");

    if (!implCalled) fail("_ensureSessionImpl() devrait être appelé pour session expirée");
    else ok("_ensureSessionImpl() appelé — chemin re-solve CF correct");

    // Restore
    mgr._reattachBrowserWithSession = origReattach;
    mgr._ensureSessionImpl = origImpl;
    mgr._page    = null;
    mgr._browser = null;
    mgr._cachedSession = null;
  }

  sep("RÉSUMÉ");
  console.log(`  Passés  : ${passed}`);
  console.log(`  Échoués : ${failed}`);
  if (failed === 0) {
    console.log("\n  ✅ Tous les tests passent — le fix est opérationnel.");
    console.log("  Le bug '_page null après crash → 0B indéfiniment' est corrigé.");
  } else {
    console.log("\n  ❌ Des tests ont échoué — voir les erreurs ci-dessus.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("❌ Exception non gérée :", err);
  process.exit(1);
});
