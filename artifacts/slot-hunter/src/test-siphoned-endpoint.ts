/**
 * Test: Reproduire la session avec cookies siphonnés et tester l'endpoint CEV bundle
 * 
 * Scénario:
 * 1. Capturer les cookies siphonnés via Playwright (F5 + ASP.NET_SessionId)
 * 2. Se connecter avec screentapinc@gmail.com / Akollad@2026
 * 3. Naviguer vers le dossier VOWINT6088211
 * 4. Résoudre le captcha
 * 5. Au lieu de suivre la redirection, interroger l'endpoint /Home/AvailableTimeSlots
 * 6. Vérifier la réponse
 */

import { setupCevSessionHttp, resolveAnticaptchaKey } from "./cevHttpSetup.js";
import { getActiveCevSessions } from "./convexClient.js";
import { cevImpitFetch, getCevBrowserHeaders } from "./cev-shared-impit.js";
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const VOWINT_EMAIL = "screentapinc@gmail.com";
const VOWINT_PASSWORD = "Akollad@2026";
const VOWINT_DOSSIER = "VOWINT6088211";
const CLIENT_ID = "test-siphoned-endpoint";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const VOWINT_BASE = "https://visaonweb.diplomatie.be";

interface SiphonedCookies {
  f5CookieValue?: string;
  f5CookieName?: string;
  aspNetSessionId?: string;
  userAgent?: string;
  validUntil?: number;
}

async function captureSiphonedCookies(): Promise<SiphonedCookies | null> {
  console.log("=== Capture des cookies siphonnés via Playwright ===\n");
  
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // Naviguer vers VOWINT
    console.log("🌐 Navigation vers VOWINT...");
    await page.goto(VOWINT_BASE, { waitUntil: 'networkidle', timeout: 30000 });

    // Se connecter
    console.log("🔐 Connexion...");
    await page.fill('input[name="UserName"], input[type="email"], #UserName', VOWINT_EMAIL);
    await page.fill('input[name="Password"], input[type="password"], #Password', VOWINT_PASSWORD);
    await page.click('input[type="submit"], button[type="submit"], .btn-primary');
    
    // Attendre la navigation avec timeout plus flexible
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {
      console.log("⚠️ Navigation timeout, continuation avec l'état actuel...");
    }
    await page.waitForTimeout(3000);

    // Attendre le fingerprinting F5
    console.log("⏳ Attente fingerprinting F5 (15s)...");
    await page.waitForTimeout(15000);

    // Récupérer les cookies F5 seulement
    const cookies = await context.cookies();
    
    // Chercher le cookie F5 (TS0110ceb4 ou similaire)
    const f5Cookie = cookies.find(c => c.name.startsWith('TS') && c.domain.includes('diplomatie.be'));

    if (!f5Cookie) {
      console.log("⚠️ Cookie F5 non trouvé");
      console.log("Cookies disponibles:", cookies.map(c => `${c.name}=${c.value.slice(0, 20)}...`).join(', '));
      return null;
    }

    const siphoned: SiphonedCookies = {
      f5CookieValue: f5Cookie.value,
      f5CookieName: f5Cookie.name,
      userAgent: await page.evaluate(() => navigator.userAgent),
      validUntil: Date.now() + (60 * 60 * 1000), // 1 heure
    };

    console.log("✅ Cookie F5 capturé:");
    console.log(`   ${f5Cookie.name}=${f5Cookie.value.slice(0, 30)}...`);

    // Sauvegarder les cookies
    const cookieFile = path.join(process.cwd(), 'siphoned-cookies.json');
    fs.writeFileSync(cookieFile, JSON.stringify(siphoned, null, 2));
    console.log(`💾 Cookie sauvegardé dans: ${cookieFile}`);

    return siphoned;

  } catch (error) {
    console.error("❌ Erreur capture cookies:", error);
    return null;
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log("=== Test: Session avec cookies siphonnés ===\n");

  // ÉTAPE 1: Capturer les cookies siphonnés via Playwright
  console.log("ÉTAPE 1: Capture des cookies siphonnés via Playwright...");
  const siphonedCookies = await captureSiphonedCookies();
  
  if (!siphonedCookies) {
    console.error("❌ Échec capture cookies siphonnés");
    process.exit(1);
  }

  // ÉTAPE 2: Setup session CEV avec cookies siphonnés
  console.log("\nÉTAPE 2: Setup session CEV avec cookies siphonnés...");
  const setupResult = await setupCevSessionHttp(
    VOWINT_EMAIL,
    VOWINT_PASSWORD,
    CLIENT_ID,
    CLIENT_ID,
    VOWINT_DOSSIER,
    siphonedCookies
  );

  if (!setupResult.success) {
    console.error(`❌ Échec du setup: ${setupResult.error}`);
    process.exit(1);
  }

  console.log(`✅ Setup réussi`);
  console.log(`   - Session Cookie: ${setupResult.sessionCookie?.slice(0, 20)}...`);
  console.log(`   - Integration URL: ${setupResult.integrationUrl?.slice(0, 80)}...`);
  console.log(`   - Redirect URL: ${setupResult.redirectUrl?.slice(0, 80)}...`);
  console.log(`   - Valid Until: ${new Date(setupResult.validUntilMs || 0).toISOString()}`);
  console.log(`   - Slots Available: ${setupResult.slotsAvailable}`);

  // ÉTAPE 3: Suivre la redirection pour activer la session
  console.log("\nÉTAPE 3: Suivre la redirection pour activer la session...");
  
  if (!setupResult.sessionCookie || !setupResult.redirectUrl) {
    console.error("❌ Session cookie ou redirect URL manquant");
    process.exit(1);
  }

  // Construire le cookie header complet
  let cookieStr = `ASP.NET_SessionId=${setupResult.sessionCookie}; PreferredCulture=en-US`;
  if (siphonedCookies?.f5CookieValue && siphonedCookies?.f5CookieName) {
    if (!siphonedCookies.validUntil || Date.now() < siphonedCookies.validUntil) {
      cookieStr = `${siphonedCookies.f5CookieName}=${siphonedCookies.f5CookieValue}; ${cookieStr}`;
    }
  }

  const userAgent = siphonedCookies?.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

  // Suivre la redirection avec redirect: 'follow' pour activer la session
  console.log(`   Suivi de: ${setupResult.redirectUrl.slice(0, 80)}...`);
  try {
    const redirectResponse = await cevImpitFetch(setupResult.redirectUrl, {
      method: "GET",
      headers: getCevBrowserHeaders({
        referer: `${CEV_BASE}/Captcha`,
        cookie: cookieStr,
        userAgent: userAgent,
      }),
      redirect: "follow", // IMPORTANT: suivre automatiquement pour activer la session
    });

    console.log(`   Status final: ${redirectResponse.status}`);
    console.log(`   URL finale: ${redirectResponse.url}`);
    
    // Mettre à jour le referer pour l'appel suivant
    setupResult.redirectUrl = redirectResponse.url;
    
    // Vérifier si on est sur SelectSlot (calendrier) ou NoAvailability
    if (redirectResponse.url.includes('/SelectSlot')) {
      console.log(`   ✅ Session activée - Page SelectSlot atteinte`);
    } else if (redirectResponse.url.includes('/NoAvailability')) {
      console.log(`   ⚠️ Pas de créneaux disponibles`);
    } else {
      console.log(`   ⚠️ Page inattendue: ${redirectResponse.url}`);
    }
  } catch (error) {
    console.error(`   Erreur suivi redirection:`, error);
  }

  // ÉTAPE 4: Tester l'endpoint /Home/AvailableTimeSlots avec session activée
  console.log("\nÉTAPE 4: Test de l'endpoint /Home/AvailableTimeSlots (session activée)...");

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const payload = {
    month: currentMonth,
    year: currentYear,
  };

  console.log(`   Payload: ${JSON.stringify(payload)}`);
  console.log(`   Cookie: ${cookieStr.slice(0, 100)}...`);

  try {
    const response = await cevImpitFetch(`${CEV_BASE}/Home/AvailableTimeSlots`, {
      method: "POST",
      headers: getCevBrowserHeaders({
        referer: setupResult.redirectUrl,
        cookie: cookieStr,
        userAgent: userAgent,
        contentType: "application/json",
        xRequestedWith: true,
      }),
      body: JSON.stringify(payload),
    });

    console.log(`\n=== RÉPONSE /Home/AvailableTimeSlots ===`);
    console.log(`Status: ${response.status}`);
    console.log(`Status Text: ${response.statusText}`);
    
    const responseText = await response.text();
    console.log(`Body (${responseText.length} chars): ${responseText.slice(0, 500)}...`);

    // Essayer de parser comme JSON
    try {
      const jsonResponse = JSON.parse(responseText);
      console.log(`\nJSON parsé:`);
      console.log(JSON.stringify(jsonResponse, null, 2));
    } catch {
      console.log(`\n⚠️ Réponse non-JSON`);
    }

    // Headers de réponse
    console.log(`\nHeaders de réponse:`);
    response.headers.forEach((value, key) => {
      console.log(`   ${key}: ${value}`);
    });

  } catch (error) {
    console.error(`❌ Erreur lors de l'appel à /Home/AvailableTimeSlots:`, error);
  }

  console.log("\n=== Test terminé ===");
}

main().catch(console.error);
