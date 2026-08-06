/**
 * test-anticlouflare-capsolver.ts — Test Option 1
 *
 * Flux :
 *   1. CapSolver AntiCloudflareTask + notre proxy Decodo
 *      → CapSolver utilise SON browser avec NOTRE proxy
 *      → Retourne : cf_clearance cookie + user-agent
 *   2. impit (Chrome TLS) + même proxy + cf_clearance
 *      → GET /main/ Bookitit → HTML du widget
 *   3. GET getservices/ → liste des services (agents, IDs)
 *   4. GET getagendas/ → agendas (avec service ID récupéré)
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx scripts/test-anticlouflare-capsolver.ts
 *
 * Env requis :
 *   CAPSOLVER_API_KEY   — clé CapSolver
 *   DECODO_PROXY_URL    — ex: http://user:pass@dc.decodo.com:10001
 *   (ou decodo-proxies.csv avec au moins une IP)
 */

import "dotenv/config";
import { Impit } from "impit";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORTAL_URL  = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const WIDGET_KEY  = "2d01502f12dc08400e22aea87fb00ae34";
const BASE_BOOK   = "https://www.citaconsular.es/onlinebookings/";
const CAPSOLVER   = "https://api.capsolver.com";

const API_KEY     = process.env.CAPSOLVER_API_KEY ?? "";
const POLL_MS     = 4_000;
const MAX_POLLS   = 50;   // ~3min max

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sep(title: string) {
  console.log("\n" + "═".repeat(68));
  console.log("  " + title);
  console.log("═".repeat(68));
}
function ok(msg: string)   { console.log("  ✅  " + msg); }
function info(msg: string) { console.log("  ℹ️   " + msg); }
function warn(msg: string) { console.log("  ⚠️   " + msg); }
function fail(msg: string) { console.log("  ❌  " + msg); }
function elapsed(ms: number) { return ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`; }

/** Récupère le premier proxy Decodo disponible */
function getProxy(): string {
  // 1. CSV
  const csv = resolve(process.cwd(), "decodo-proxies.csv");
  if (existsSync(csv)) {
    const lines = readFileSync(csv, "utf-8").split("\n")
      .map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    if (lines.length > 0) {
      const [host, port, user, ...passParts] = lines[0].split(":");
      const pass = passParts.join(":");
      const url = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
      info(`Proxy depuis CSV : ${url.replace(/:([^@:]+)@/, ":***@")}`);
      return url;
    }
  }
  // 2. Env
  const env = process.env.DECODO_PROXY_URL ?? "";
  if (env) {
    info(`Proxy depuis env : ${env.replace(/:([^@:]+)@/, ":***@")}`);
    return env;
  }
  throw new Error("Proxy introuvable — configure DECODO_PROXY_URL ou decodo-proxies.csv");
}

/** Convertit http://user:pass@host:port → format attendu par CapSolver */
function proxyForCapsolver(url: string): string {
  // CapSolver accepte le format standard http://user:pass@host:port
  return url;
}

// ─── Étape 1 : CapSolver AntiCloudflareTask ──────────────────────────────────

async function solveWithCapsolver(proxyUrl: string): Promise<{
  cfClearance: string;
  userAgent:   string;
  allCookies:  Array<{ name: string; value: string }>;
}> {
  sep("ÉTAPE 1 — CapSolver AntiCloudflareTask");
  info(`URL cible : ${PORTAL_URL}`);
  info(`Proxy     : ${proxyUrl.replace(/:([^@:]+)@/, ":***@")}`);

  // Créer la tâche
  const t0 = Date.now();
  const createRes = await fetch(`${CAPSOLVER}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: API_KEY,
      task: {
        type:       "AntiCloudflareTask",
        websiteURL: PORTAL_URL,
        proxy:      proxyForCapsolver(proxyUrl),
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const createData = await createRes.json() as any;

  if (createData.errorId !== 0 || !createData.taskId) {
    throw new Error(`CapSolver createTask échoué : ${createData.errorCode ?? createData.errorDescription ?? JSON.stringify(createData)}`);
  }
  ok(`Tâche créée : ${createData.taskId}`);
  info("Polling résultat (max 3min)…");

  // Poller
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));

    const pollRes = await fetch(`${CAPSOLVER}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: API_KEY, taskId: createData.taskId }),
      signal: AbortSignal.timeout(15_000),
    });
    const pollData = await pollRes.json() as any;

    if (pollData.errorId !== 0) {
      warn(`Poll #${i+1} erreur : ${pollData.errorCode ?? pollData.errorId}`);
      continue;
    }
    if (pollData.status === "processing") {
      process.stdout.write(`  ⏳ Poll #${i+1}… \r`);
      continue;
    }
    if (pollData.status === "ready") {
      const sol = pollData.solution ?? {};
      console.log(); // newline après les ⏳
      ok(`Challenge résolu en ${elapsed(Date.now() - t0)}`);
      // Log complet de la solution pour diagnostic
      info(`Solution brute : ${JSON.stringify(sol).slice(0, 600)}`);
      info(`User-Agent : ${(sol.userAgent ?? "").slice(0, 80)}`);

      // ── Normaliser les cookies ──────────────────────────────────────────────
      // CapSolver peut retourner :
      //   • Array<{name,value}>   (format standard)
      //   • string "name=value; name2=value2"  (format header)
      //   • objet {name: value}   (format map)
      //   • absent / null
      let cookieList: Array<{ name: string; value: string }> = [];

      if (Array.isArray(sol.cookies)) {
        cookieList = sol.cookies;
      } else if (typeof sol.cookies === "string" && sol.cookies.length > 0) {
        // Parser "name=value; name2=value2"
        cookieList = sol.cookies.split(";").map((part: string) => {
          const eq = part.indexOf("=");
          if (eq === -1) return null;
          return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
        }).filter(Boolean) as Array<{ name: string; value: string }>;
      } else if (sol.cookies && typeof sol.cookies === "object") {
        cookieList = Object.entries(sol.cookies).map(([name, value]) => ({ name, value: String(value) }));
      }

      info(`Cookies normalisés : ${cookieList.length} — ${cookieList.map(c => c.name).join(", ")}`);

      // ── Chercher cf_clearance ───────────────────────────────────────────────
      const cfCookieEntry = cookieList.find(c => c.name === "cf_clearance");

      // Certaines versions de l'API retournent cf_clearance dans sol.token
      const cfValue = cfCookieEntry?.value ?? (
        typeof sol.token === "string" && sol.token.includes(".") ? sol.token : null
      );

      if (!cfValue) {
        throw new Error(
          `cf_clearance introuvable dans la solution.\n` +
          `Solution complète : ${JSON.stringify(pollData).slice(0, 800)}`
        );
      }

      ok(`cf_clearance : ${cfValue.slice(0, 50)}…`);
      return {
        cfClearance: cfValue,
        userAgent:   sol.userAgent ?? "",
        allCookies:  cookieList,
      };
    }
  }
  throw new Error(`Timeout CapSolver (${MAX_POLLS} polls × ${POLL_MS}ms)`);
}

// ─── impit helpers ────────────────────────────────────────────────────────────

function buildCookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function buildJar(
  cfClearance: string,
  allCookies: Array<{ name: string; value: string }>,
): Map<string, string> {
  const jar = new Map<string, string>();
  for (const c of allCookies) jar.set(c.name, c.value);
  jar.set("cf_clearance", cfClearance);
  return jar;
}

/** Parse Set-Cookie headers and merge into jar */
function mergeSetCookies(headers: Headers, jar: Map<string, string>): void {
  // impit may expose multiple Set-Cookie as comma-joined or separate
  const raw = headers.get("set-cookie") ?? "";
  if (!raw) return;
  for (const part of raw.split(/,(?=[^ ])/)) {
    const nameVal = part.split(";")[0].trim();
    const eq = nameVal.indexOf("=");
    if (eq === -1) continue;
    const name  = nameVal.slice(0, eq).trim();
    const value = nameVal.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

async function impitFetch(
  url: string,
  impit: InstanceType<typeof Impit>,
  jar: Map<string, string>,
  userAgent: string,
  referer: string,
  method: "GET" | "POST" = "GET",
  body?: string,
  mode: "navigate" | "jsonp" | "form" = "navigate",
): Promise<{ status: number; body: string; ct: string; headers: Headers }> {

  // ── Headers selon le mode (Bug S1 — Burp 2026-06-25) ──────────────────────
  // JSONP = jQuery XHR → Sec-Fetch-Mode:cors, Sec-Fetch-Dest:empty
  // navigate = navigation normale → Sec-Fetch-Mode:navigate, Dest:document
  const secFetch: Record<string, string> = mode === "jsonp"
    ? {
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
        "Accept-Language": "fr-FR,fr;q=0.9",
      }
    : mode === "navigate"
    ? {
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
      }
    : {
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept-Language": "fr-FR,fr;q=0.9",
      };

  // ── sec-ch-ua hints (Bug S2 — CF envoie Accept-CH, Chrome répond vides) ───
  const chHints: Record<string, string> = {
    "Sec-Ch-Ua-Platform-Version": '""',
    "Sec-Ch-Ua-Full-Version": '""',
    "Sec-Ch-Ua-Full-Version-List": '""',
    "Sec-Ch-Ua-Arch": '""',
    "Sec-Ch-Ua-Bitness": '""',
    "Sec-Ch-Ua-Model": '""',
  };

  const res = await impit.fetch(url, {
    method,
    headers: {
      "Cookie":     buildCookieHeader(jar),
      "User-Agent": userAgent,
      "Referer":    referer,
      ...secFetch,
      ...chHints,
    },
    ...(body ? { body } : {}),
  } as any);
  const text = await res.text();
  mergeSetCookies(res.headers, jar);
  return { status: res.status, body: text, ct: res.headers.get("content-type") ?? "", headers: res.headers };
}

// ─── Parser JSONP ─────────────────────────────────────────────────────────────

function parseJsonp(raw: string): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* */ }
  const m = raw.match(/^[\w$]+\((.+)\);?\s*$/s);
  if (m) { try { return JSON.parse(m[1]); } catch { /* */ } }
  // Certains portails envoient le HTML directement dans le callback
  const m2 = raw.match(/^[\w$]+\(([\s\S]+)\);?\s*$/);
  if (m2) { try { return JSON.parse(m2[1]); } catch { /* */ } }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  sep("TEST — CapSolver AntiCloudflareTask + impit HTTP pur");

  if (!API_KEY) throw new Error("CAPSOLVER_API_KEY manquant");
  const proxyUrl = getProxy();

  // ── Instance impit UNIQUE pour toute la session ──────────────────────────────
  // Une seule instance = une seule session TLS → CF accepte le cf_clearance sur
  // tous les appels suivants (le fingerprint TLS reste cohérent).
  const impit = new Impit({ browser: "chrome", proxyUrl } as any);

  // ── Étape 1 : Solve CF ──────────────────────────────────────────────────────
  const { cfClearance, userAgent, allCookies } = await solveWithCapsolver(proxyUrl);

  const jar = buildJar(cfClearance, allCookies);
  const ua  = userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // ── Cookies dans l'ordre exact du Burp 2026-06-25 ──────────────────────────
  // Ordre obligatoire : _ga ; _ga_F3TYSDL945 ; PHPSESSID ; cf_clearance (en dernier)
  // CF pose cf_clearance lui-même en dernier → le browser l'envoie en dernier.
  const nowSec = Math.floor(Date.now() / 1000);
  const rnd9   = Math.floor(100_000_000 + Math.random() * 900_000_000);
  const pastTs = nowSec - Math.floor(Math.random() * 30 * 86400);
  const gaVal  = `GA1.1.${rnd9}.${pastTs}`;
  const ga4Val = `GS2.1.s${nowSec}$o1$g0$t${nowSec}$j60$l0$h0`;

  // Jar initial = GA only (pas encore de PHPSESSID ni cf_clearance)
  // cf_clearance sera ajouté EN DERNIER après que PHPSESSID soit connu.
  jar.clear();
  jar.set("_ga",            gaVal);
  jar.set("_ga_F3TYSDL945", ga4Val);
  // Pour le GET portail on ajoute cf_clearance temporairement, puis on le retire pour le remettre en dernier
  info(`Cookies jar initiaux : _ga, _ga_F3TYSDL945 (cf_clearance + PHPSESSID ajoutés après portail)`);

  // ── Étape 1b : GET portail → PHPSESSID ──────────────────────────────────────
  // Envoi : _ga + _ga_F3 + cf_clearance (nécessaire pour passer CF)
  // Après réponse : reconstruire le jar dans l'ordre exact Burp :
  //   _ga ; _ga_F3TYSDL945 ; PHPSESSID ; cf_clearance (CF en dernier)
  sep("ÉTAPE 1b — GET portail → PHPSESSID (même proxy)");
  info(`GET ${PORTAL_URL}`);

  // Ajouter cf_clearance temporairement pour passer CF sur le GET portail
  jar.set("cf_clearance", cfClearance);
  const t1b = Date.now();
  const portalResult = await impitFetch(PORTAL_URL, impit, jar, ua, "https://www.citaconsular.es/", "GET", undefined, "navigate");
  info(`Status : ${portalResult.status} | ${portalResult.body.length}B | ct=${portalResult.ct} | ${elapsed(Date.now()-t1b)}`);

  const phpSessId = jar.get("PHPSESSID") ?? "";
  if (phpSessId) {
    ok(`PHPSESSID obtenu : ${phpSessId.slice(0, 20)}…`);
  } else {
    warn("PHPSESSID absent — le portail n'a peut-être pas chargé correctement");
    info(`Corps (200c) : ${portalResult.body.slice(0, 200)}`);
  }

  // ── Reconstruire le jar dans l'ordre exact Burp ─────────────────────────────
  jar.clear();
  jar.set("_ga",            gaVal);
  jar.set("_ga_F3TYSDL945", ga4Val);
  if (phpSessId) jar.set("PHPSESSID", phpSessId);
  jar.set("cf_clearance", cfClearance); // en dernier ← ordre CF
  info(`Cookies jar (ordre final) : ${[...jar.keys()].join(", ")}`);

  // ── Étape 1c : POST portail avec le token Bookitit → initialiser session ───
  // Le portail Bookitit affiche une page "Continue / Continuar" avec un token
  // hidden dans un formulaire. Le PHP attend ce POST pour marquer la session
  // comme "initialisée". Sans ça, getservices/ renvoie 0B.
  sep("ÉTAPE 1c — POST portail avec token Bookitit (Continue / Continuar)");

  // Extraire le token depuis le HTML du portail
  const tokenMatch = portalResult.body.match(
    /<input[^>]*name=["']token["'][^>]*value=["']([^"']+)["']/
  ) ?? portalResult.body.match(
    /name="token"\s+value="([^"]+)"/
  ) ?? portalResult.body.match(
    /value="([a-f0-9]{30,40})"/
  );

  if (!tokenMatch) {
    warn("Token Bookitit introuvable dans le HTML du portail");
    info(`HTML extrait : ${portalResult.body.slice(0, 500)}`);
  } else {
    const bookititToken = tokenMatch[1];
    ok(`Token Bookitit extrait : ${bookititToken}`);

    const postBody = `token=${encodeURIComponent(bookititToken)}`;
    const t1c = Date.now();
    const postResult = await impitFetch(
      PORTAL_URL, impit, jar, ua, PORTAL_URL,
      "POST", postBody, "form"
    );
    info(`Status : ${postResult.status} | ${postResult.body.length}B | ct=${postResult.ct} | ${elapsed(Date.now()-t1c)}`);
    info(`Cookies jar après POST : ${[...jar.keys()].join(", ")}`);

    info(`POST token → ${postResult.body.length}B`);
    // Afficher le HTML complet du POST response pour comprendre l'état suivant
    console.log("\n--- POST RESPONSE BODY ---");
    console.log(postResult.body);
    console.log("--- FIN POST RESPONSE ---\n");
  }

  const ts = `${Date.now()}`;

  // ── Étape 2 : GET /main/ via impit ──────────────────────────────────────────
  sep("ÉTAPE 2 — GET /main/ via impit");
  const mainCb  = `jQuery_main_${ts}`;
  const mainUrl = `${BASE_BOOK}main/?callback=${mainCb}&type=default&publickey=${WIDGET_KEY}&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&srvsrc=https%3A%2F%2Fwww.citaconsular.es&_=${ts}`;
  info(`URL : ${mainUrl.slice(0, 110)}…`);
  info(`Cookies envoyés : ${[...jar.keys()].join(", ")}`);

  const t2 = Date.now();
  const mainResult = await impitFetch(mainUrl, impit, jar, ua, PORTAL_URL, "GET", undefined, "jsonp");
  info(`Status : ${mainResult.status} | ${mainResult.body.length}B | ct=${mainResult.ct} | ${elapsed(Date.now()-t2)}`);
  info(`Cookies jar après /main/ : ${[...jar.keys()].join(", ")}`);

  if (mainResult.body.length === 0) {
    fail("/main/ → 0B (CF ou PHPSESSID invalide)");
    info("Extrait headers response : " + mainResult.headers.get("cf-ray") + " | " + mainResult.headers.get("location"));
  } else if (mainResult.ct.includes("text/html") && mainResult.body.length < 5000) {
    warn("/main/ → text/html court (CF redirect)");
    info(`Extrait : ${mainResult.body.slice(0, 300)}`);
  } else {
    ok(`/main/ → ${mainResult.body.length}B (${mainResult.ct})`);
    info(`Extrait : ${mainResult.body.slice(0, 150)}…`);

    // ── Parser le corps de /main/ ──────────────────────────────────────────────
    sep("PARSE /main/ — contenu embarqué");
    const mainBody = mainResult.body;

    // 1. oClientValues_<id> global config
    const oClientMatch = mainBody.match(/var (oClientValues_\d+)\s*=\s*(\{[\s\S]*?\})\s*[;\n]/);
    if (oClientMatch) {
      ok(`oClientValues trouvé : ${oClientMatch[1]}`);
      try {
        const cfg = JSON.parse(oClientMatch[2]);
        info(`  widgetconfiguration.captcha  = ${cfg.widgetconfiguration?.captcha}`);
        info(`  widgetconfiguration.reg_type = ${cfg.widgetconfiguration?.registration_type}`);
        info(`  waiting_list                 = ${cfg.widgetconfiguration?.waiting_list}`);
        info(`  widgetcustom présent         = ${!!cfg.widgetcustom}`);
      } catch { warn("parse oClientValues JSON échoué"); }
    } else {
      warn("oClientValues non trouvé dans /main/");
    }

    // 2. Services embarqués (format JSON dans les templates Backbone)
    const serviceIds: string[] = [];
    const serviceRe = /"id"\s*:\s*"(\d{3,8})"\s*,\s*"name"\s*:\s*"([^"]{1,100})"/g;
    let sm: RegExpExecArray | null;
    while ((sm = serviceRe.exec(mainBody)) !== null) {
      serviceIds.push(sm[1]);
      const name = sm[2].replace(/<[^>]*>/g, "").trim().slice(0, 60);
      console.log(`       🔹 Service id=${sm[1]} | ${name}`);
    }
    if (serviceIds.length > 0) ok(`${serviceIds.length} service(s) trouvé(s) dans /main/`);
    else warn("Aucun service embarqué dans /main/ (getservices/ requis)");

    // 3. "No hay horas" / "No hay citas" — signal de scan
    const noHoras = /no hay horas|no_hours|no hay citas disponibles|No dates available/i.test(mainBody);
    if (noHoras) ok("Signal 'No hay horas' présent → scanner fonctionnel");
    else         info("Signal 'No hay horas' absent (peut signifier des créneaux dispo ou template non chargé)");

    // 4. Agendas embarqués
    const agendaRe = /"idAgenda"\s*:\s*"?(\d{3,8})"?/g;
    const agendaIds: string[] = [];
    let am: RegExpExecArray | null;
    while ((am = agendaRe.exec(mainBody)) !== null) agendaIds.push(am[1]);
    if (agendaIds.length > 0) ok(`${agendaIds.length} agenda(s) trouvé(s) : ${[...new Set(agendaIds)].slice(0,5).join(", ")}`);
    else info("Pas d'agenda embarqué dans /main/");

    // 5. Cookie order check — CF behavioral scoring attend _ga en premier
    const cookiesSent = buildCookieHeader(jar);
    const gaFirst = cookiesSent.startsWith("_ga=");
    if (!gaFirst) warn(`Cookie order : ${cookiesSent.slice(0,60)}… — CF attend _ga en premier`);
    else ok("Cookie order correct (_ga en premier)");
  }

  // ── Étape 3 : getwidgetconfigurations/ ──────────────────────────────────────
  // Bug S4 : companions arrivent ~3s après /main/ (GTM doit charger d'abord)
  sep("ÉTAPE 3 — getwidgetconfigurations/ (délai ~3s comme navigateur réel)");
  const delay3s = 2800 + Math.floor(Math.random() * 800); // 2800–3600ms
  info(`Attente ${delay3s}ms (GTM load)…`);
  await new Promise(r => setTimeout(r, delay3s));

  const cfgCb  = `jQuery_cfg_${ts}`;
  const cfgUrl = `${BASE_BOOK}getwidgetconfigurations/?callback=${cfgCb}&type=default&publickey=${WIDGET_KEY}&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts}`;
  const t3 = Date.now();
  const cfgResult = await impitFetch(cfgUrl, impit, jar, ua, PORTAL_URL, "GET", undefined, "jsonp");
  info(`Status : ${cfgResult.status} | ${cfgResult.body.length}B | ${elapsed(Date.now()-t3)}`);
  const cfgParsed = parseJsonp(cfgResult.body) as any;
  if (cfgParsed?.WidgetConfiguration) {
    const wc = cfgParsed.WidgetConfiguration;
    ok(`widgetConfig — captcha=${wc.captcha} | reg_type=${wc.registration_type} | waiting=${wc.waiting_list}`);
  } else if (cfgResult.body.length > 0) {
    warn(`Parse JSONP échoué — extrait : ${cfgResult.body.slice(0, 200)}`);
  } else {
    fail("getwidgetconfigurations/ → 0B");
  }

  // ── Étape 4 : getservices/ ───────────────────────────────────────────────────
  // Bug S4 : getservices/ arrive 9ms après getwidgetconfigurations/
  sep("ÉTAPE 4 — getservices/ (9ms après getwidgetconfigurations/)");
  await new Promise(r => setTimeout(r, 9));
  const svcCb  = `jQuery_svc_${ts}`;
  const svcUrl = `${BASE_BOOK}getservices/?callback=${svcCb}&type=default&publickey=${WIDGET_KEY}&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts}`;
  const t4 = Date.now();
  const svcResult = await impitFetch(svcUrl, impit, jar, ua, PORTAL_URL, "GET", undefined, "jsonp");
  info(`Status : ${svcResult.status} | ${svcResult.body.length}B | ct=${svcResult.ct} | ${elapsed(Date.now()-t4)}`);

  let serviceId = "";
  const svcParsed = parseJsonp(svcResult.body) as any;
  const services: Array<{ id: string; name?: string }> =
    Array.isArray(svcParsed) ? svcParsed :
    Array.isArray(svcParsed?.Services) ? svcParsed.Services : [];

  if (services.length > 0) {
    ok(`${services.length} service(s) :`);
    for (const s of services) {
      const nameClean = (s.name ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 60);
      console.log(`       🔹 ID=${s.id} | ${nameClean}`);
      if (!serviceId) serviceId = s.id;
    }
  } else if (svcResult.body.length > 0) {
    warn(`Parse JSONP — extrait : ${svcResult.body.slice(0, 200)}`);
  } else {
    fail("getservices/ → 0B");
  }

  // ── Étape 5 : getagendas/ (si service ID obtenu) ────────────────────────────
  let agendaOk = false;
  if (serviceId) {
    sep(`ÉTAPE 5 — getagendas/ (service=${serviceId})`);
    const agCb  = `jQuery_ag_${ts}`;
    const agUrl = `${BASE_BOOK}getagendas/?callback=${agCb}&type=default&publickey=${WIDGET_KEY}&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&services%5B%5D=${serviceId}&_=${ts}`;
    const t5 = Date.now();
    const agResult = await impitFetch(agUrl, impit, jar, ua, PORTAL_URL, "GET", undefined, "jsonp");
    info(`Status : ${agResult.status} | ${agResult.body.length}B | ct=${agResult.ct} | ${elapsed(Date.now()-t5)}`);

    const agParsed = parseJsonp(agResult.body) as any;
    const agendas: Array<{ idAgenda: string; agendaName?: string }> =
      Array.isArray(agParsed?.agendas) ? agParsed.agendas : [];

    if (agendas.length > 0) {
      agendaOk = true;
      ok(`${agendas.length} agenda(s) :`);
      for (const a of agendas) console.log(`       🔹 ID=${a.idAgenda} | ${a.agendaName ?? "(sans nom)"}`);
    } else if (agResult.body.length > 0) {
      warn(`Parse / 0 agenda — extrait : ${agResult.body.slice(0, 200)}`);
    } else {
      fail("getagendas/ → 0B (machine d'état côté serveur — clic service requis en navigateur)");
    }
  }

  // ── Résumé ───────────────────────────────────────────────────────────────────
  sep("RÉSUMÉ");
  const mainOk = mainResult.body.length > 10_000;
  const steps: [string, string][] = [
    ["CapSolver AntiCloudflareTask",     cfClearance ? "✅" : "❌"],
    ["PHPSESSID (GET portail)",          jar.has("PHPSESSID") ? "✅" : "❌"],
    ["/main/ Bookitit",                  mainOk ? "✅" : mainResult.body.length > 0 ? "⚠️ " : "❌"],
    ["getwidgetconfigurations/",         cfgParsed?.WidgetConfiguration ? "✅" : cfgResult.body.length > 0 ? "⚠️ " : "❌"],
    ["getservices/",                     services.length > 0 ? "✅" : svcResult.body.length > 0 ? "⚠️ " : "❌"],
    ["getagendas/",                      serviceId ? (agendaOk ? "✅" : "❌ (état serveur)") : "⏭️  skipped"],
  ];
  for (const [label, icon] of steps) console.log(`  ${icon}  ${label}`);
  console.log();
}

main().catch(err => {
  console.error("\n💥 Erreur non gérée :", err instanceof Error ? err.message : err);
  process.exit(1);
});
