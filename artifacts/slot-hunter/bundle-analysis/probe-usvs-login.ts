/**
 * probe-usvs-login.ts — Test de reconnaissance du login Azure AD B2C de
 * usvisascheduling.com. NE construit PAS le bot : il tente UNE fois le POST
 * /SelfAsserted et affiche la réponse serveur pour déterminer la difficulté
 * (succès / mauvais creds / captcha Atlas requis / autre).
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   tsx bundle-analysis/probe-usvs-login.ts
 *
 * Flux (une seule session impit, cf_clearance frais) :
 *   1. GET page login → cf challenge → CapSolver → cf_clearance
 *   2. GET page login (post-clearance) → extraire SETTINGS { tenant, api, csrf, transId, policy }
 *   3. POST {tenant}/SelfAsserted?... csrf_token + tx + p  avec signInName+password
 *   4. Afficher status + corps (JSON B2C : {status, message} ou redirect)
 *
 * Aucune donnée sensible n'est journalisée (ni mot de passe, ni csrf complet).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as dotenv from "dotenv";
import { Impit } from "impit";

import { solveSpainCloudflare } from "../src/spain-soax-solver.js";
import { getCurrentDecodoUrl } from "../src/spain-decodo-pool.js";

dotenv.config();
const localEnv = path.join(process.cwd(), ".env");
if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv, override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_URL = "https://www.usvisascheduling.com/";
// Flux OIDC B2C : l'authentification se fait sur atlasauth.b2clogin.com, PAS sur
// l'origine du portail. On démarre par le endpoint /authorize qui pose les cookies
// B2C et sert la page login (self-asserted) avec un csrf/transId propres à CE host.
const B2C_HOST = "https://atlasauth.b2clogin.com";
const B2C_TENANT = "atlasauth.onmicrosoft.com";
const B2C_POLICY = "B2C_1A_atoproduction_Atlas_SUSI";
const B2C_CLIENT_ID = "607d08d6-b63b-4735-ad82-05dfcff7efa4";
const B2C_REDIRECT_URI = "https://www.usvisascheduling.com/en-US/SignIn";
const B2C_AUTHORIZE_URL =
  `${B2C_HOST}/${B2C_TENANT}/oauth2/v2.0/authorize` +
  `?p=${B2C_POLICY}&client_id=${B2C_CLIENT_ID}&nonce=defaultNonce` +
  `&redirect_uri=${encodeURIComponent(B2C_REDIRECT_URI)}` +
  `&scope=openid&response_type=id_token&prompt=login&ui_locales=en-US`;
const FALLBACK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** Agrège les Set-Cookie d'une réponse dans un jar simple name=value. */
function mergeSetCookies(jar: Record<string, string>, res: Response): void {
  // impit expose les en-têtes via headers.get; Set-Cookie peut être multiple.
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
  for (const line of raw) {
    const first = line.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
}

function jarToHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

interface B2CSettings {
  hosts?: { tenant?: string; policy?: string };
  tenant?: string;
  api?: string;
  csrf?: string;
  transId?: string;
  policy?: string;
  pageViewId?: string;
  remoteResource?: string;
}

/** Extrait l'objet SETTINGS = {...}; injecté inline dans le HTML B2C. */
function extractSettings(html: string): B2CSettings | undefined {
  const m = /SETTINGS\s*=\s*(\{[\s\S]*?\});/.exec(html);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]) as B2CSettings;
  } catch {
    return undefined;
  }
}

function isCfChallenge(status: number, body: string): boolean {
  return status === 403 || /just a moment|_cf_chl_opt|challenge-platform/i.test(body.slice(0, 4000));
}

async function main(): Promise<void> {
  const capsolverApiKey = process.env.CAPSOLVER_API_KEY?.trim() ?? "";
  const ispProxy = getCurrentDecodoUrl() || process.env.DECODO_PROXY_URL?.trim() || "";
  const username = process.env.USVISASCHEDULING_USERNAME?.trim() ?? "";
  const password = process.env.USVISASCHEDULING_MDP?.trim() ?? "";

  if (!capsolverApiKey || !ispProxy) {
    console.error("[usvs-login] ❌ CAPSOLVER_API_KEY ou proxy ISP manquant.");
    process.exit(1);
  }
  if (!username || !password) {
    console.error("[usvs-login] ❌ USVISASCHEDULING_USERNAME / USVISASCHEDULING_MDP manquant dans .env.");
    process.exit(1);
  }
  console.log(`[usvs-login] 👤 Compte : ${username.slice(0, 3)}***${username.includes("@") ? "@" + username.split("@")[1] : ""}`);

  const impit = new Impit({ browser: "chrome", proxyUrl: ispProxy, timeout: 60_000, followRedirects: true } as unknown as ConstructorParameters<typeof Impit>[0]);
  const jar: Record<string, string> = {};

  // ── 1. GET /authorize sur atlasauth.b2clogin.com (host B2C réel) ────────────
  // Microsoft B2C n'est PAS derrière Cloudflare → pas de CapSolver ici. Ce GET pose
  // les cookies de session B2C (x-ms-cpim-*) et sert la page login self-asserted
  // avec un csrf/transId propres à CE host.
  console.log("[usvs-login] 🔍 GET /authorize (atlasauth.b2clogin.com)…");
  let body = "";
  const ua = FALLBACK_UA;
  try {
    const r = (await impit.fetch(B2C_AUTHORIZE_URL, {
      headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
    } as RequestInit)) as Response;
    mergeSetCookies(jar, r);
    body = await r.text();
    console.log(`[usvs-login]   authorize → HTTP ${r.status} (${body.length}B) | cookies B2C: ${Object.keys(jar).length}`);
    if (isCfChallenge(r.status, body)) {
      console.log("[usvs-login]   ⚠️ Challenge CF inattendu sur b2clogin — stop.");
      process.exit(1);
    }
  } catch (err) {
    console.error("[usvs-login] ❌ GET authorize échoué :", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // ── 2. Extraire SETTINGS (csrf/transId propres à b2clogin.com) ──────────────
  const settings = extractSettings(body);
  if (!settings) {
    console.error("[usvs-login] ❌ SETTINGS introuvable dans la page authorize — flux inattendu.");
    fs.writeFileSync(path.join(__dirname, "usvs-authorize-debug.html"), body);
    console.log("[usvs-login]   HTML sauvegardé → usvs-authorize-debug.html");
    process.exit(1);
  }
  const tenant = settings.hosts?.tenant ?? settings.tenant ?? "";
  const api = settings.api ?? "SelfAsserted";
  const csrf = settings.csrf ?? "";
  const transId = settings.transId ?? "";
  const policy = settings.hosts?.policy ?? settings.policy ?? B2C_POLICY;
  console.log(`[usvs-login] 📋 SETTINGS: api=${api} policy=${policy} tenant=${tenant.slice(0, 55)}… csrf=${csrf ? "présent(" + csrf.length + ")" : "ABSENT"} transId=${transId ? "présent" : "ABSENT"}`);
  console.log(`[usvs-login] 🧩 remoteResource (captcha ?) : ${settings.remoteResource ?? "(aucun)"}`);

  if (!tenant || !csrf || !transId) {
    console.error("[usvs-login] ❌ tenant/csrf/transId incomplets — impossible de poster.");
    process.exit(1);
  }

  // ── 3. POST /SelfAsserted sur atlasauth.b2clogin.com ────────────────────────
  const postUrl = `${B2C_HOST}${tenant}/SelfAsserted?tx=${encodeURIComponent(transId)}&p=${encodeURIComponent(policy)}`;
  const form = new URLSearchParams({
    request_type: "RESPONSE",
    signInName: username,
    password,
  }).toString();

  console.log(`[usvs-login] 📤 POST SelfAsserted → ${postUrl.slice(0, 100)}…`);
  try {
    const r = (await impit.fetch(postUrl, {
      method: "POST",
      headers: {
        "User-Agent": ua,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-CSRF-TOKEN": csrf,
        "X-Requested-With": "XMLHttpRequest",
        Origin: B2C_HOST,
        Referer: B2C_AUTHORIZE_URL,
        Cookie: jarToHeader(jar),
      },
      body: form,
    } as RequestInit)) as Response;
    mergeSetCookies(jar, r);

    const respBody = await r.text();
    console.log("");
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log(`║  Réponse SelfAsserted : HTTP ${r.status}`);
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`[usvs-login] Corps (${respBody.length}B) :`);
    console.log(respBody.slice(0, 800));

    // Interprétation B2C : {"status":"200"} = OK, {"status":"400","message":...} = erreur creds/captcha
    try {
      const parsed = JSON.parse(respBody) as { status?: string; message?: string };
      if (parsed.status === "200") {
        console.log("\n[usvs-login] ✅ LOGIN ACCEPTÉ (status 200) — étape confirmed/redirect possible, pas de captcha bloquant.");
      } else if (parsed.message && /captcha/i.test(parsed.message)) {
        console.log("\n[usvs-login] 🧩 CAPTCHA REQUIS dans le login B2C — reverse captcha Atlas nécessaire.");
      } else {
        console.log(`\n[usvs-login] ⚠️ Réponse B2C status=${parsed.status} message="${parsed.message ?? ""}"`);
      }
    } catch {
      if (/captcha/i.test(respBody)) console.log("\n[usvs-login] 🧩 CAPTCHA détecté dans la réponse (non-JSON).");
      else console.log("\n[usvs-login] ⚠️ Réponse non-JSON — voir le corps ci-dessus.");
    }
  } catch (err) {
    console.error("[usvs-login] ❌ POST échoué :", err instanceof Error ? err.message : err);
  }
}

main().catch((err) => {
  console.error("[usvs-login] FATAL :", err);
  process.exit(1);
});
