/**
 * Test JWT ↔ IP (portail USA) + validation du proxy « sticky » utilisé en prod.
 *
 * Sonde : POST /identity/user/refreshToken (même egress que `refreshUsaToken`) — le portail
 * refuse en général le refresh depuis une autre IP que celle du login.
 *
 * Mécanisme réel côté client :
 *  - Login et appels API passent par `setUsaSessionProxy` → `usaFetch` → undici `ProxyAgent`
 *    (même IP de sortie pour toute la session).
 *  - Si le JWT est réutilisé depuis une autre IP (fetch direct ou autre proxy), le portail
 *    renvoie typiquement 401.
 *
 * Prérequis (.env) :
 *  - USA_TEST_EMAIL, USA_TEST_PASSWORD (ou USA_EMAIL / USA_PASSWORD comme les autres scripts)
 *  - Soit TWOCAPTCHA_API_KEY (IP serveur whitelistée chez 2captcha) → pool résidentiel + sticky,
 *    soit IPROYAL_PROXY_URL (par défaut ce test ajoute une session sticky 60 min iProyal ;
 *    IPROYAL_STICKY_MINUTES=0 pour désactiver et utiliser l’URL brute).
 *
 * Debug : USA_DEBUG_LOGIN_JSON=1 — trace le JSON de login (usa-auth).
 *
 * Usage : npx tsx src/test-usa-jwt-ip-binding.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { ProxyAgent } from "undici";
import { loginUsaPortal, setUsaSessionProxy } from "./usaPortal.js";
import { AccountRestrictedError } from "./usaPortal/errors.js";
import {
  makeIproyalStickyUrl,
  usaFetch,
  getBrowserHeaders,
} from "./usaPortal/usa-http.js";
import { USA_REFRESH_URL, REFERER_DASHBOARD } from "./usaPortal/config.js";
import type { UsaSession } from "./usaPortal/types.js";
import { proxyPool } from "./browser.js";
import { detectPublicIp } from "./proxyPool.js";

const IP_CHECK = "https://api.ipify.org?format=json";

function stripBearer(t: string | null | undefined): string {
  if (!t) return "";
  return t.trim().replace(/^Bearer\s+/i, "").trim();
}

/** IP vue depuis la même pile que le bot (`usaFetch` + proxy global si actif). */
async function fetchJsonIpViaUsaFetch(): Promise<string> {
  try {
    const res = await usaFetch(IP_CHECK, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) {
      console.warn(`[jwt-ip] ipify via proxy → HTTP ${res.status}`);
      return "unknown";
    }
    const j = (await res.json()) as { ip?: string };
    return j.ip ?? "unknown";
  } catch (e) {
    console.warn(`[jwt-ip] ipify via proxy indisponible (proxy / tunnel) — poursuite sans IP ref: ${e instanceof Error ? e.message : e}`);
    return "unknown";
  }
}

async function fetchJsonIpDirect(): Promise<string> {
  try {
    const res = await fetch(IP_CHECK, { signal: AbortSignal.timeout(20_000) });
    const j = (await res.json()) as { ip?: string };
    return j.ip ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function postRefreshToken(
  username: string,
  refreshToken: string,
  label: string,
  dispatcher: ProxyAgent | undefined,
  onSuccessUpdate: (newRefresh: string) => void,
): Promise<number> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      ...getBrowserHeaders(),
      "Content-Type": "application/json",
      "Referer": REFERER_DASHBOARD,
    },
    body: JSON.stringify({ refreshToken, username }),
    signal: AbortSignal.timeout(45_000),
    ...(dispatcher ? { dispatcher } : {}),
  };
  const res = dispatcher
    ? await fetch(USA_REFRESH_URL, init)
    : await usaFetch(USA_REFRESH_URL, init);
  console.log(`[jwt-ip] ${label} → HTTP ${res.status}`);
  if (res.status !== 200 && res.status !== 429) {
    const t = await res.text().catch(() => "");
    if (t) console.warn(`[jwt-ip] corps réponse (extrait): ${t.slice(0, 400)}`);
  }
  if (res.ok) {
    const nr = res.headers.get("refreshtoken");
    if (nr) onSuccessUpdate(stripBearer(nr));
  }
  return res.status;
}

type ProxyMode = "iproyal" | "2captcha" | "none";

async function resolveStickyProxy(username: string): Promise<{ url: string | undefined; mode: ProxyMode }> {
  const iproyal = process.env.IPROYAL_PROXY_URL;
  if (iproyal) {
    const minsRaw = process.env.IPROYAL_STICKY_MINUTES;
    const url =
      minsRaw === "0"
        ? iproyal
        : makeIproyalStickyUrl(iproyal, minsRaw ? parseInt(minsRaw, 10) || 60 : 60);
    return { url, mode: "iproyal" };
  }
  if (!proxyPool.isConfigured) {
    return { url: undefined, mode: "none" };
  }
  const p = await proxyPool.getStickyProxy(username.toLowerCase());
  return { url: p ?? undefined, mode: "2captcha" };
}

async function main(): Promise<void> {
  const email = (process.env.USA_TEST_EMAIL ?? process.env.USA_EMAIL)?.trim();
  const password = (process.env.USA_TEST_PASSWORD ?? process.env.USA_PASSWORD)?.trim();
  if (!email || !password) {
    console.error(
      "[jwt-ip] Définir USA_TEST_EMAIL / USA_TEST_PASSWORD (ou USA_EMAIL / USA_PASSWORD) dans l’environnement ou le .env.",
    );
    process.exit(1);
  }

  const has2captcha = Boolean(process.env.TWOCAPTCHA_API_KEY);
  const hasIproyal = Boolean(process.env.IPROYAL_PROXY_URL);

  console.log("=".repeat(64));
  console.log(" TEST USA — liaison JWT / IP (proxy identique à la prod)");
  console.log("=".repeat(64));
  console.log(`Compte      : ${email}`);
  console.log(`2captcha    : ${has2captcha ? "oui" : "non"}`);
  console.log(`iProyal     : ${hasIproyal ? "oui" : "non"}`);

  if (has2captcha && !hasIproyal) {
    const serverIp = await detectPublicIp();
    if (!serverIp) {
      console.error("[jwt-ip] Impossible de détecter l’IP publique — pool 2captcha inutilisable.");
      process.exit(1);
    }
    await proxyPool.initialize(serverIp);
  }

  const { url: stickyUrl, mode } = await resolveStickyProxy(email);
  if (!stickyUrl || mode === "none") {
    console.error(
      "[jwt-ip] Aucun proxy résidentiel (TWOCAPTCHA_API_KEY + whitelist, ou IPROYAL_PROXY_URL). Arrêt.",
    );
    process.exit(1);
  }

  const masked = stickyUrl.replace(/:([^:@]+)@/, ":***@");
  console.log(`Proxy sticky: ${masked} (${mode})`);

  // Même ProxyAgent global que login + scans (évite deux instances iProyal / egress différents).
  setUsaSessionProxy(stickyUrl);
  const ipAtLogin = await fetchJsonIpViaUsaFetch();
  console.log(`[jwt-ip] IP sortante (usaFetch + ce proxy, avant login) : ${ipAtLogin}`);

  let session: UsaSession | null;
  try {
    session = await loginUsaPortal(email, password);
  } catch (e) {
    if (e instanceof AccountRestrictedError) {
      console.error(
        "[jwt-ip] Compte temporairement restreint par le portail USA (trop de tentatives / anti-bot). Réessayez plus tard ou changez de proxy/IP.",
      );
      setUsaSessionProxy(undefined);
      if (mode === "2captcha") proxyPool.releaseStickyProxy(email);
      process.exit(2);
    }
    console.error("[jwt-ip] Login exception:", e);
    setUsaSessionProxy(undefined);
    if (mode === "2captcha") proxyPool.releaseStickyProxy(email);
    process.exit(1);
  }

  if (!session?.accessToken) {
    console.error("[jwt-ip] Login sans accessToken.");
    setUsaSessionProxy(undefined);
    if (mode === "2captcha") proxyPool.releaseStickyProxy(email);
    process.exit(1);
  }
  if (!session.refreshToken) {
    console.error("[jwt-ip] Login sans refreshToken — impossible de tester POST /refreshToken.");
    setUsaSessionProxy(undefined);
    if (mode === "2captcha") proxyPool.releaseStickyProxy(email);
    process.exit(1);
  }

  let liveRefresh = session.refreshToken;
  const bumpRefresh = (nr: string) => {
    if (nr) liveRefresh = nr;
  };

  // ── A. Même proxy / usaFetch (undici) : refresh doit réussir si le refresh token est valide ──
  const okSame = await postRefreshToken(
    email,
    liveRefresh,
    "POST /refreshToken (usaFetch + proxy prod)",
    undefined,
    bumpRefresh,
  );
  if (okSame !== 200 && okSame !== 429) {
    console.error(`[jwt-ip] Échec attendu 200 ou 429 sur même IP (refresh), obtenu ${okSame}.`);
    setUsaSessionProxy(undefined);
    if (mode === "2captcha") proxyPool.releaseStickyProxy(email);
    process.exit(1);
  }

  // ── B. Même refresh token depuis une autre IP (connexion directe, sans proxy) ──
  setUsaSessionProxy(undefined);
  const ipDirect = await fetchJsonIpDirect();
  console.log(`[jwt-ip] IP sortante sans proxy (machine) : ${ipDirect}`);

  const wrongDirect = await postRefreshToken(
    email,
    liveRefresh,
    "POST /refreshToken (direct, autre IP)",
    undefined,
    bumpRefresh,
  );
  const expectReject = wrongDirect === 401 || wrongDirect === 403;
  if (expectReject) {
    console.log("[jwt-ip] ✓ Refresh refusé depuis une autre IP — liaison IP cohérente.");
  } else {
    console.warn(
      `[jwt-ip] ⚠ HTTP ${wrongDirect} en direct — pas 401/403 : liaison IP absente ou refresh toléré.`,
    );
  }

  // ── C. Optionnel : autre proxy résidentiel (pool 2captcha) ──
  let wrongAlt = -1;
  let ipAlt = "";
  if (mode === "2captcha" && proxyPool.isConfigured) {
    const alt = await proxyPool.getProxy();
    if (alt?.proxy && alt.proxy !== stickyUrl) {
      const altAgent = new ProxyAgent(alt.proxy);
      const altIpRes = await fetch(IP_CHECK, {
        signal: AbortSignal.timeout(20_000),
        dispatcher: altAgent,
      } as RequestInit);
      const altIpJson = (await altIpRes.json()) as { ip?: string };
      ipAlt = altIpJson.ip ?? "unknown";
      console.log(`[jwt-ip] IP sortante proxy « autre » (pool) : ${ipAlt}`);
      wrongAlt = await postRefreshToken(
        email,
        liveRefresh,
        "POST /refreshToken (autre proxy pool)",
        altAgent,
        bumpRefresh,
      );
      if (wrongAlt === 401) {
        console.log("[jwt-ip] ✓ Refresh 401 avec un second proxy (IP ≠ login).");
      } else {
        console.warn(`[jwt-ip] ⚠ Autre proxy → HTTP ${wrongAlt} (souvent 401 si IP ≠ login).`);
      }
    }
  }

  // ── D. Restaurer le proxy sticky : refresh à nouveau possible ──
  setUsaSessionProxy(stickyUrl);
  const restored = await postRefreshToken(
    email,
    liveRefresh,
    "POST /refreshToken (proxy sticky restauré)",
    undefined,
    bumpRefresh,
  );
  setUsaSessionProxy(undefined);
  if (mode === "2captcha") proxyPool.releaseStickyProxy(email);

  if (restored !== 200 && restored !== 429) {
    console.error(`[jwt-ip] Après restauration du proxy, attendu 200/429 (refresh), obtenu ${restored}.`);
    process.exit(1);
  }
  console.log("[jwt-ip] ✓ Proxy d’origine : refresh à nouveau accepté.");

  console.log("\n── Synthèse ──");
  console.log(`  IP login (sticky)     : ${ipAtLogin}`);
  console.log(`  IP sans proxy         : ${ipDirect}`);
  console.log(`  Même proxy (refresh)  : HTTP ${okSame}`);
  console.log(`  Direct + refresh      : HTTP ${wrongDirect} ${expectReject ? "(401/403 ✓)" : "(surprise)"}`);
  if (wrongAlt >= 0) console.log(`  Autre proxy + refresh : HTTP ${wrongAlt}`);
  console.log(`  Restauré sticky       : HTTP ${restored}`);
  console.log("=".repeat(64));
}

main().catch((e) => {
  console.error(e);
  setUsaSessionProxy(undefined);
  process.exit(1);
});
