import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { cookieManager } from "./cookie-manager.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
}

/** Cookies complets extraits après que JSD Oneshot ait tourné dans le vrai navigateur. */
export interface SpainWidgetCookies {
  /** cf_clearance post-JSD-Oneshot (le "#2" de Burp). */
  cfClearance: string;
  /** Tous les cookies du contexte navigateur (cf_clearance, PHPSESSID, _ga…). */
  allCookies: Array<{ name: string; value: string }>;
  userAgent: string;
  capturedAt: number;
  /** True only when the browser observed Cloudflare's JSD Oneshot request. */
  jsdOneshotCaptured: boolean;
  /**
   * CapSolver can return a clearance that makes citaconsular serve the widget
   * directly. In that branch Cloudflare does not load the intermediate JSD
   * page, so there is no browser JSD request to wait for.
   */
  seededClearanceAccepted: boolean;
}

export interface SeedCookie {
  name: string;
  value: string;
}

// Apply stealth plugin to Playwright Extra
const chromiumStealth = chromium as any;
chromiumStealth.use((StealthPlugin as any)());

/**
 * Attempts to automatically click the Cloudflare Turnstile checkbox if it appears
 */
async function forceClickTurnstile(page: any): Promise<boolean> {
  try {
    console.log("[PLAYWRIGHT-STEALTH] 🔍 Recherche de l'Iframe Cloudflare Turnstile...");

    // 1. Attendre que l'iframe Cloudflare apparaisse
    await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: 10000 });
    
    // 2. Cibler l'élément iframe
    const iframeElement = await page.$('iframe[src*="challenges.cloudflare.com"]');
    if (!iframeElement) return false;

    console.log("[PLAYWRIGHT-STEALTH] 🎯 Iframe trouvé. Calcul des coordonnées physiques...");
    
    // 3. Récupérer les coordonnées (Bounding Box)
    const box = await iframeElement.boundingBox();
    if (!box) return false;

    // Calcul du centre de la case à cocher (généralement sur la gauche de l'iframe)
    const clicX = box.x + 45;
    const clicY = box.y + box.height / 2;

    console.log(`[PLAYWRIGHT-STEALTH] 🖲️ Déplacement de la souris vers [X: ${clicX}, Y: ${clicY}]...`);

    // 4. Déplacement fluide de la souris
    await page.mouse.move(clicX, clicY, { steps: 25 });
    
    // Micro-pause
    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 400) + 200));

    // 5. Clic physique
    await page.mouse.click(clicX, clicY);
    console.log("[PLAYWRIGHT-STEALTH] 🔘 Clic de la case exécuté.");
    
    return true;
  } catch (error) {
    console.log("[PLAYWRIGHT-STEALTH] ℹ️ Pas de case Turnstile visible ou impossible de cliquer.");
    return false;
  }
}

/**
 * Resolves Cloudflare using a semi-invisible Playwright browser window positioned off-screen.
 */
export async function solveWithLocalPlaywright(
  portalUrl: string,
  proxyUrl?: string,
): Promise<boolean> {
  console.log("[PLAYWRIGHT-STEALTH] 👻 Lancement du faux-headless indétectable...");

  const domain = new URL(portalUrl).hostname;
  let proxyConfig: PlaywrightProxy | undefined;
  if (proxyUrl) {
    try {
      const parsed = new URL(proxyUrl);
      proxyConfig = {
        server: `http://${parsed.hostname}:${parsed.port || "5000"}`,
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      };
      console.log(`[PLAYWRIGHT-STEALTH] 🔌 Proxy: ${parsed.hostname}:${parsed.port}`);
    } catch {
      console.warn("[PLAYWRIGHT-STEALTH] ⚠️ Impossible de parser l'URL proxy");
      return false;
    }
  }

  // Lancement en mode visible (headless: false) pour éviter la détection simple,
  // mais déplacé hors de l'écran principal pour rester invisible pour l'utilisateur
  const legacyLaunchOptions: Record<string, unknown> = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-position=-2000,-2000',
      '--window-size=1200,800',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  };
  if (proxyConfig) legacyLaunchOptions.proxy = proxyConfig;
  const browser = await chromiumStealth.launch(legacyLaunchOptions);

  const contextOptions: Record<string, unknown> = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1200, height: 800 },
    locale: 'fr-FR',
    timezoneId: 'Africa/Kinshasa'
  };
  const context = await browser.newContext(contextOptions);

  try {
    const page = await context.newPage();
    
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    console.log(`[PLAYWRIGHT-STEALTH] Navigation furtive vers ${portalUrl}...`);
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Attente pour laisser Turnstile et ses frames s'initialiser
    console.log("[PLAYWRIGHT-STEALTH] ⏳ Attente de chargement initial...");
    await new Promise(resolve => setTimeout(resolve, 8000));

    let cookies = await context.cookies();
    let cfClearance = cookies.find((c: any) => c.name === 'cf_clearance');

    if (!cfClearance) {
      console.log("[PLAYWRIGHT-STEALTH] Cookie cf_clearance non détecté immédiatement. Tentative de clic...");
      const clicked = await forceClickTurnstile(page);
      if (clicked) {
        console.log("[PLAYWRIGHT-STEALTH] ⏳ Clic effectué, attente de validation...");
        await new Promise(resolve => setTimeout(resolve, 8000));
      } else {
        console.log("[PLAYWRIGHT-STEALTH] ⏳ Pas de case cliquable détectée, attente de résolution passive...");
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }

    // Deuxième vérification après tentative de clic/résolution
    const updatedCookies = await context.cookies();
    const finalCfCookie = updatedCookies.find((c: any) => c.name === 'cf_clearance');

    if (!finalCfCookie) {
      throw new Error("Le cookie cf_clearance n'a pas pu être obtenu.");
    }

    console.log(`[PLAYWRIGHT-STEALTH] 🎯 SUCCÈS ! Cookie cf_clearance extrait : ${finalCfCookie.value.slice(0, 30)}...`);

    // Enregistrer dans le CookieManager
    cookieManager.addCookie({
      name: finalCfCookie.name,
      value: finalCfCookie.value,
      domain: finalCfCookie.domain || `.${domain}`,
      path: finalCfCookie.path || '/',
      expires: finalCfCookie.expires || (Math.floor(Date.now() / 1000) + 7200),
      httpOnly: !!finalCfCookie.httpOnly,
      secure: !!finalCfCookie.secure,
      sameSite: (finalCfCookie.sameSite as any) || 'None',
      source: 'automatic',
      validFor: [domain, 'citaconsular.es', 'www.citaconsular.es']
    });

    return true;

  } catch (error: any) {
    console.error(`[PLAYWRIGHT-STEALTH] ❌ Échec de la feinte locale : ${error.message}`);
    return false;
  } finally {
    await browser.close();
    console.log("[PLAYWRIGHT-STEALTH] 🔋 Instance fermée proprement.");
  }
}

// ─── solveSpainWidgetSession ──────────────────────────────────────────────────

/**
 * Établit une session citaconsular.es complète via un vrai navigateur Playwright.
 *
 * POURQUOI : Le corps du JSD Oneshot (body envoyé à /cdn-cgi/challenge-platform/.../jsd/oneshot/...)
 * est calculé par le JS de Cloudflare dans le navigateur (Proof-of-Work + fingerprint télémétrique).
 * Il est impossible à reproduire en HTTP-only sans exécuter ce JS.
 * Cette fonction laisse le navigateur charger le widget → CF JS tourne → JSD Oneshot se déclenche
 * automatiquement → cf_clearance #2 est capturé depuis la réponse Set-Cookie.
 *
 * ARCHITECTURE IP :
 * Le proxy SOAX fourni doit être LE MÊME sticky-session que celui qu'impit utilisera ensuite
 * pour les appels JSONP. cf_clearance est lié à l'IP du solve — une IP différente = 403.
 *
 * @param widgetUrl   - URL du widget citaconsular (ex: /es/hosteds/widgetdefault/<pk>/)
 * @param soaxProxyUrl - URL proxy SOAX sticky (format http://user:pass@host:port).
 *                       Si absent → connexion directe (IP Replit, utile pour tests locaux).
 * @returns SpainWidgetCookies avec cf_clearance #2, PHPSESSID et tous les cookies du contexte.
 */
export async function solveSpainWidgetSession(
  widgetUrl: string,
  soaxProxyUrl?: string,
  seedCookies: SeedCookie[] = [],
): Promise<SpainWidgetCookies | null> {
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

  // ─── Parse proxy SOAX ────────────────────────────────────────────────────
  let proxyConfig: PlaywrightProxy | undefined;
  if (soaxProxyUrl) {
    try {
      const parsed = new URL(soaxProxyUrl);
      proxyConfig = {
        server: `http://${parsed.hostname}:${parsed.port || "5000"}`,
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      };
      console.log(`[PLAYWRIGHT-WIDGET] 🔌 Proxy SOAX: ${parsed.hostname}:${parsed.port}`);
    } catch {
      console.warn("[PLAYWRIGHT-WIDGET] ⚠️ Impossible de parser l'URL proxy — connexion directe");
    }
  }

  // Les workers Replit/Railway n'ont généralement pas de display X11.
  // Utiliser headless dans ce cas évite un échec de lancement, sans modifier
  // le contexte navigateur ni les requêtes exécutées par le site.
  const isHeadlessEnv =
    !!(process.env.RAILWAY_ENVIRONMENT || process.env.CI) || !process.env.DISPLAY;

  const launchOptions: Record<string, unknown> = {
    headless: isHeadlessEnv,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      // Position plausible (coin haut-gauche d'un écran 1920×1080) plutôt que -2000,-2000
      // CF JS peut lire window.screenX/Y — une position hors-écran est un signal bot connu.
      "--window-position=80,60",
      "--window-size=1280,720",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
  if (proxyConfig) launchOptions.proxy = proxyConfig;
  const browser = await chromiumStealth.launch(launchOptions);

  const contextOptions: Record<string, unknown> = {
    userAgent: UA,
    viewport: { width: 1280, height: 720 },
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  };
  const context = await browser.newContext(contextOptions);

  try {
    const page = await context.newPage();

    if (seedCookies.length > 0) {
      await context.addCookies(
        seedCookies.map((cookie) => ({
          ...cookie,
          domain: ".citaconsular.es",
          path: "/",
        })),
      );
      console.log(
        `[PLAYWRIGHT-WIDGET] 🍪 Session CapSolver injectée (${seedCookies.length} cookie(s))`,
      );
    }

    // ─── Patch fingerprint JS ─────────────────────────────────────────────
    // CF's challenge script lit plusieurs propriétés du navigateur pour détecter l'automation.
    // On corrige les valeurs qui trahissent headless / Playwright.
    await page.addInitScript(() => {
      // webdriver doit être undefined (Playwright le set à true par défaut)
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });

      // Écran plausible — screenX/Y proches de la position fenêtre (--window-position=80,60)
      Object.defineProperty(window, "screenX", { get: () => 80 });
      Object.defineProperty(window, "screenY", { get: () => 60 });
      Object.defineProperty(window, "outerWidth",  { get: () => 1280 });
      Object.defineProperty(window, "outerHeight", { get: () => 720 });
      Object.defineProperty(screen, "width",       { get: () => 1920 });
      Object.defineProperty(screen, "height",      { get: () => 1080 });
      Object.defineProperty(screen, "availWidth",  { get: () => 1920 });
      Object.defineProperty(screen, "availHeight", { get: () => 1040 }); // barre des tâches ~40px
      Object.defineProperty(screen, "colorDepth",  { get: () => 24 });
      Object.defineProperty(screen, "pixelDepth",  { get: () => 24 });
    });

    // ─── Listener : capture cf_clearance #2 depuis réponse JSD Oneshot ───
    // CF's JS déclenche automatiquement POST /cdn-cgi/challenge-platform/.../jsd/oneshot/...
    // La réponse contient Set-Cookie: cf_clearance=<nouveau_token>
    let postOneshotCfClearance: string | null = null;
    let jsdOneshotCaptured = false;
    let seededClearanceAccepted = false;
    page.on("request", (request: any) => {
      const url: string = request.url();
      if (
        url.includes("/cdn-cgi/challenge-platform/") &&
        url.includes("/jsd/oneshot/")
      ) {
        jsdOneshotCaptured = true;
        console.log("[PLAYWRIGHT-WIDGET] ✅ Requête JSD Oneshot observée dans le navigateur");
      }
    });
    page.on("response", async (response: any) => {
      try {
        const url: string = response.url();
        if (
          url.includes("/cdn-cgi/challenge-platform/") &&
          url.includes("/jsd/oneshot/")
        ) {
          jsdOneshotCaptured = true;
          const headers: Record<string, string> = response.headers();
          const setCookie: string = headers["set-cookie"] ?? "";
          const match = /cf_clearance=([^;]+)/.exec(setCookie);
          if (match) {
            postOneshotCfClearance = match[1]!;
            console.log(
              `[PLAYWRIGHT-WIDGET] ✅ JSD Oneshot déclenché — cf_clearance #2: ${postOneshotCfClearance.slice(0, 20)}…`
            );
          } else {
            console.log(`[PLAYWRIGHT-WIDGET] ℹ️ JSD Oneshot détecté (status ${response.status()}) — pas de Set-Cookie cf_clearance`);
          }
        }
      } catch {
        // Ignore erreurs listener (réponses interrompues)
      }
    });

    // ─── Navigation vers le widget ────────────────────────────────────────
    console.log(`[PLAYWRIGHT-WIDGET] 🌐 Navigation vers ${widgetUrl}…`);
    await page.goto(widgetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // ─── Phase 1 : Playwright essaie d'abord le challenge natif ───────────
    // Si la case "je ne suis pas un robot" est affichée, le clic est tenté
    // dans ce premier passage. Le fallback CapSolver est orchestré par
    // ensureSpainCfSession(), puis relance cette même fonction avec ses cookies.
    console.log("[PLAYWRIGHT-WIDGET] ⏳ Premier essai Playwright — attente du challenge CF (~8s)…");
    await new Promise<void>((r) => setTimeout(r, 8_000));

    let cookies = await context.cookies();
    let cfClearance = cookies.find((c: any) => c.name === "cf_clearance");

    if (!cfClearance) {
      console.log("[PLAYWRIGHT-WIDGET] 🔘 cf_clearance absent — tentative clic Turnstile…");
      const clicked = await forceClickTurnstile(page);
      await new Promise<void>((r) => setTimeout(r, clicked ? 10_000 : 12_000));
      cookies = await context.cookies();
      cfClearance = cookies.find((c: any) => c.name === "cf_clearance");
    }

    if (!cfClearance) {
      throw new Error("cf_clearance #1 non obtenu — CF Turnstile non résolu");
    }
    console.log(`[PLAYWRIGHT-WIDGET] 🍪 cf_clearance #1: ${cfClearance.value.slice(0, 20)}…`);

    // Le portail réel utilise un formulaire POST avec le token caché. Le
    // soumettre dans le navigateur permet au site et à Cloudflare d'exécuter
    // leur séquence native; il ne faut pas reconstruire ce POST à la main.
    const tokenInput = page.locator('input[name="token"]').first();
    if (await tokenInput.count()) {
      const form = tokenInput.locator("xpath=ancestor::form[1]");
      console.log("[PLAYWRIGHT-WIDGET] 🔘 Soumission native du formulaire token…");
      await form.evaluate((node: any) => node.submit());
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
      await new Promise<void>((r) => setTimeout(r, 2_000));
    } else {
      console.log("[PLAYWRIGHT-WIDGET] ℹ️ Formulaire token absent — page déjà sur le widget.");
      if (seedCookies.some((cookie) => cookie.name === "cf_clearance")) {
        seededClearanceAccepted = true;
        console.log(
          "[PLAYWRIGHT-WIDGET] ✅ Clearance CapSolver acceptée — " +
            "widget servi directement, JSD intermédiaire absent",
        );
      }
    }

    // ─── Phase 2 : Attente JSD Oneshot (JS CF tournant dans le navigateur) ──
    // Le widget HTML est chargé, CF's JS s'exécute et déclenche JSD Oneshot ~3-8s après.
    // On attend TOUJOURS le JSD, même si la clearance CapSolver a été acceptée.
    //
    // IMPORTANT: quand seededClearanceAccepted=true, CF sert le widget directement
    // sans interstitiel, MAIS son JS continue de s'exécuter en arrière-plan et émet
    // quand même le JSD Oneshot pour fingerprinter le client. Ce JSD produit une
    // cf_clearance #2 liée à l'IP Decodo courante — indispensable pour les requêtes
    // HTTP impit qui suivent. Skipper cette attente laisse seulement la clearance
    // CapSolver (liée au contexte browser de CapSolver) qui est rejetée par CF en HTTP.
    console.log(
      seededClearanceAccepted
        ? "[PLAYWRIGHT-WIDGET] ⏳ Clearance CapSolver acceptée — attente JSD Oneshot arrière-plan (obligatoire pour HTTP)…"
        : "[PLAYWRIGHT-WIDGET] ⏳ Attente JSD Oneshot (exécution JS CF dans le navigateur)…",
    );
    const ONESHOT_TIMEOUT_MS = 20_000;
    const tWait = Date.now();
    while (
      !jsdOneshotCaptured &&
      Date.now() - tWait < ONESHOT_TIMEOUT_MS
    ) {
      await new Promise<void>((r) => setTimeout(r, 500));
    }

    if (!jsdOneshotCaptured && !seededClearanceAccepted) {
      throw new Error(
        "JSD Oneshot requis mais non observé — aucun fallback cf_clearance #1",
      );
    }

    if (!jsdOneshotCaptured && seededClearanceAccepted) {
      // CF n'a pas émis de JSD Oneshot après 20s malgré la clearance CapSolver acceptée.
      // La clearance retournée sera celle de CapSolver — peut échouer en HTTP impit.
      console.warn(
        "[PLAYWRIGHT-WIDGET] ⚠️ JSD Oneshot non observé après 20s (clearance CapSolver uniquement) — " +
        "le scan HTTP risque un 403. Renouvellement forcé au prochain cycle.",
      );
    }

    // ─── Phase 3 : Extraction cookies finaux ─────────────────────────────
    const finalBrowserCookies = await context.cookies();
    const allCookies = finalBrowserCookies.map((c: any) => ({
      name: c.name as string,
      value: c.value as string,
    }));

    // Priorité : cf_clearance #2 capturé depuis JSD Oneshot (lié à l'IP Decodo courante).
    // Fallback : cf_clearance présent dans le jar navigateur (token CapSolver — peut échouer HTTP).
    const finalCfClearance =
      postOneshotCfClearance ??
      finalBrowserCookies.find((c: any) => c.name === "cf_clearance")?.value ??
      "";
    if (!finalCfClearance) {
      throw new Error("Aucun cf_clearance final capturé (ni JSD Oneshot ni cookie navigateur)");
    }

    const phpSessIdCookie = finalBrowserCookies.find((c: any) => c.name === "PHPSESSID");
    console.log(
      `[PLAYWRIGHT-WIDGET] 🎯 Session établie | ` +
      `cf_clearance=${postOneshotCfClearance ? "#2 (post-Oneshot ✅)" : "#2 (cookie navigateur ⚠️CapSolver-only)"} | ` +
      `PHPSESSID=${phpSessIdCookie ? `✅ ${phpSessIdCookie.value.slice(0, 10)}…` : "❌ absent"} | ` +
      `Cookies total: ${allCookies.length}`
    );

    return {
      cfClearance: finalCfClearance,
      allCookies,
      userAgent: UA,
      capturedAt: Date.now(),
      jsdOneshotCaptured,
      seededClearanceAccepted,
    };
  } catch (err: any) {
    console.error(`[PLAYWRIGHT-WIDGET] ❌ Échec solveSpainWidgetSession: ${err.message}`);
    return null;
  } finally {
    await browser.close();
    console.log("[PLAYWRIGHT-WIDGET] 🔋 Instance fermée.");
  }
}
