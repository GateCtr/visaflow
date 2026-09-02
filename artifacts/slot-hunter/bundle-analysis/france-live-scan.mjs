/**
 * france-live-scan.mjs — POC de scan LIVE (lecture seule) du portail France/Troov.
 *
 * Reproduit le bootstrap anti-bot Troov et interroge l'endpoint de disponibilités pour
 * CAPTURER les DTOs réels (structure des créneaux, slotValue) et VALIDER le flux.
 * AUCUN booking n'est effectué — uniquement handshake + GET teams + GET availability.
 *
 * Usage : node bundle-analysis/france-live-scan.mjs [teamName=Kinshasa] [serviceName]
 */
import https from "https";

const API = "https://api.consulat.gouv.fr/api";
const ORIGIN = "https://consulat.gouv.fr";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TEAM_NAME = process.argv[2] || "Kinshasa";
const SERVICE_NAME = process.argv[3] || ""; // ex: "ADF - Demande d'inscription au Registre..."

/** Requête HTTPS bas niveau exposant les headers (nécessaire pour le handshake). */
function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "fr-FR,fr;q=0.9",
        Origin: ORIGIN,
        Referer: ORIGIN + "/",
        ...headers,
      },
    };
    const r = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on("error", reject);
    if (body) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Lit une variable depuis .env (le POC ne charge pas dotenv). */
function readEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const fs = require("fs");
    const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
    const m = env.match(new RegExp(`^${name}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

/**
 * Résout un token Cloudflare Turnstile via CapSolver (AntiTurnstileTaskProxyLess, HTTP pur).
 * POC — la vraie implémentation réutilisera src/capsolver-turnstile.ts.
 */
async function solveTurnstile(websiteURL, websiteKey, apiKey) {
  const CAP = "https://api.capsolver.com";
  if (!apiKey) {
    console.error("   ❌ CAPSOLVER_API_KEY absente");
    return null;
  }
  const create = await fetch(`${CAP}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: "AntiTurnstileTaskProxyLess", websiteURL, websiteKey },
    }),
  }).then((r) => r.json());
  if (create.errorId !== 0 || !create.taskId) {
    console.error(`   ❌ createTask: ${create.errorCode ?? create.errorId} ${create.errorDescription ?? ""}`);
    return null;
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${CAP}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: create.taskId }),
    }).then((r) => r.json());
    if (res.status === "ready" && res.solution?.token) return res.solution.token;
    if (res.errorId !== 0) {
      console.error(`   ❌ getTaskResult: ${res.errorCode ?? res.errorId}`);
      return null;
    }
    if (i % 5 === 4) console.log(`   ⏳ CapSolver poll #${i + 1}…`);
  }
  return null;
}

import { createRequire } from "module";
const require = createRequire(import.meta.url);

async function main() {
  // 1. Handshake — récupère x-gouv-handshake (csrf) + x-gouv-app-id.
  console.log("1. HEAD /handshake");
  const hs = await req("HEAD", `${API}/handshake`);
  const csrf = hs.headers["x-gouv-handshake"];
  const appId = hs.headers["x-gouv-app-id"];
  console.log(`   HTTP ${hs.status} | x-gouv-handshake=${csrf ? csrf.slice(0, 12) + "…" : "ABSENT"} | app-id=${appId ? "OK" : "ABSENT"} | x-gouv-limit=${hs.headers["x-gouv-limit"] ?? "?"}`);
  if (!csrf) {
    console.error("   ❌ Pas de handshake — impossible de continuer");
    process.exit(1);
  }
  const authHeaders = { "x-csrf-token": csrf, "x-gouv-app-id": appId };

  // 2. GET /team/slug/{slug} — résout le slug d'URL en team complète (endpoint réel du portail).
  const slug = process.env.FR_SLUG || "ambassade-de-france-a-kinshasa";
  console.log(`\n2. GET /team/slug/${slug}`);
  const teamsRes = await req("GET", `${API}/team/slug/${slug}?lang=fr`, {
    headers: authHeaders,
  });
  console.log(`   HTTP ${teamsRes.status} (${teamsRes.body.length}B)`);
  const teamData = parseJson(teamsRes.body);
  const team = teamData && (teamData._id ? teamData : teamData.team || teamData.data);
  if (!team || !(team._id || team.id)) {
    console.log(`   Réponse brute (extrait): ${teamsRes.body.slice(0, 400)}`);
    console.error("   ❌ Team introuvable via slug");
    process.exit(1);
  }
  const teamId = team._id || team.id;
  console.log(`   ✅ team: ${team.name} | _id=${teamId}`);
  // Sauvegarder la réponse team complète pour analyse hors-ligne (services, config).
  await import("fs").then((fs) =>
    fs.writeFileSync(new URL("./france-bundle/team-kinshasa.json", import.meta.url), teamsRes.body),
  );
  // Lister les services de la team pour repérer le service ADF (avec créneaux).
  const services = team.services || team.zones || [];
  if (services.length) {
    console.log(`   Services (${services.length}) :`);
    services.forEach((s) => {
      const sid = s._id || s.id || "?";
      console.log(`      - ${s.name || s.label} (id=${sid})`);
    });
  }

  // 3. Résoudre Turnstile (CapSolver, proxyless) — requis pour créer une session.
  const SITEKEY = "0x4AAAAAAAc-bWzy0zJTmAqs";
  const capKey = readEnv("CAPSOLVER_API_KEY") || readEnv("NONECAP_API_KEY");
  console.log(`\n3. Résolution Turnstile (CapSolver) — sitekey ${SITEKEY}`);
  const token = await solveTurnstile(ORIGIN + "/", SITEKEY, capKey);
  if (!token) {
    console.error("   ❌ Token Turnstile non obtenu — arrêt (pas de session possible).");
    process.exit(1);
  }
  console.log(`   ✅ token: ${token.slice(0, 40)}…`);

  // 4. POST /reservations-session — crée la session (consomme le token Turnstile).
  console.log(`\n4. POST /team/${teamId}/reservations-session (service="${SERVICE_NAME || "Service des Visas"}")`);
  const sess = await req("POST", `${API}/team/${teamId}/reservations-session`, {
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: {
      standaloneServiceName: SERVICE_NAME || "Service des Visas",
      sessionId: undefined,
      captcha: token,
    },
  });
  console.log(`   HTTP ${sess.status} (${sess.body.length}B)`);
  const sessData = parseJson(sess.body);
  const sessionId = sessData && (sessData._id || sessData.id || (sessData.session && sessData.session._id));
  if (!sessionId) {
    console.log(`   Réponse brute (extrait): ${sess.body.slice(0, 400)}`);
    console.error("   ❌ sessionId non obtenu");
    process.exit(1);
  }
  console.log(`   ✅ sessionId=${sessionId}`);
  // Sauvegarder la réponse de session pour analyse (structure services/zones/dates attendues).
  await import("fs").then((fs) =>
    fs.writeFileSync(new URL("./france-bundle/session-sample.json", import.meta.url), sess.body),
  );
  console.log(`   Clés session: ${sessData ? Object.keys(sessData).join(", ") : "?"}`);
  // Le POST renvoie un nouveau handshake header → à rejouer sur les appels suivants.
  const csrf2 = sess.headers["x-gouv-handshake"] || csrf;
  const scanHeaders = { ...authHeaders, "x-csrf-token": csrf2 };

  // 5. GET availability AVEC sessionId + DATE (obligatoire) — le SCAN réel (lecture seule).
  // ── STRATÉGIE DE SCAN OPTIMALE (comme le frontend) ──────────────────────────
  const webHeaders = { ...scanHeaders, "x-gouv-web": "fr.gouv.consulat" };
  const serviceId = process.env.FR_SERVICE_ID || "6346e242c47b29722d5f5f4e"; // ADF par défaut

  // 5a. get-interval → fenêtre officielle [start, end] pour ce service.
  console.log(`\n5a. GET reservations/get-interval?serviceId=${serviceId}`);
  const iv = await req("GET", `${API}/team/${teamId}/reservations/get-interval?serviceId=${serviceId}`, {
    headers: webHeaders,
  });
  const interval = parseJson(iv.body) || {};
  console.log(`   HTTP ${iv.status} → start=${interval.start} end=${interval.end}`);
  const startDate = interval.start || new Date().toISOString().slice(0, 10);
  const endDate = interval.end || startDate;

  // 5b. exclude-days → jours fermés (fériés + week-ends + jours sans ouverture).
  console.log(`\n5b. POST reservations/exclude-days {session:{${serviceId}:true}}`);
  const ex = await req("POST", `${API}/team/${teamId}/reservations/exclude-days`, {
    headers: { ...webHeaders, "Content-Type": "application/json" },
    body: { session: { [serviceId]: true }, sessionId },
  });
  const excluded = new Set(Array.isArray(parseJson(ex.body)) ? parseJson(ex.body) : []);
  console.log(`   HTTP ${ex.status} → ${excluded.size} jour(s) exclu(s)`);

  // 5c. Construire la liste des jours À SCANNER = [start,end] \ exclude-days.
  const daysToScan = [];
  for (let day = new Date(startDate + "T00:00:00Z"); day <= new Date(endDate + "T00:00:00Z"); day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    if (!excluded.has(date)) daysToScan.push(date);
  }
  const totalSpan =
    Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
  console.log(
    `\n5c. Scan ciblé : ${daysToScan.length} jour(s) ouvrable(s) sur ${totalSpan} ` +
      `(${totalSpan - daysToScan.length} exclus évités) — name="${SERVICE_NAME || "(vide)"}"`,
  );

  // 5d. Scanner UNIQUEMENT les jours ouvrables.
  const found = [];
  for (const date of daysToScan) {
    const url =
      `${API}/team/${teamId}/reservations/availability` +
      `?name=${encodeURIComponent(SERVICE_NAME)}&date=${date}&places=1&matching=&maxCapacity=1&sessionId=${sessionId}`;
    const r = await req("GET", url, { headers: webHeaders });
    const slots = parseJson(r.body);
    const n = Array.isArray(slots) ? slots.length : 0;
    if (n > 0) {
      found.push({ date, slots });
      console.log(`   ✅ ${date} → ${n} créneau(x) : ${slots.map((s) => s.time).join(", ")}`);
    } else {
      console.log(`   ·  ${date} → 0`);
    }
    await new Promise((res) => setTimeout(res, 250));
  }

  await import("fs").then((fs) =>
    fs.writeFileSync(
      new URL("./france-bundle/availability-sample.json", import.meta.url),
      JSON.stringify({ interval, excludedCount: excluded.size, daysScanned: daysToScan.length, found }, null, 2),
    ),
  );
  const totalSlots = found.reduce((s, f) => s + f.slots.length, 0);
  console.log(
    `\n   BILAN : ${found.length} jour(s) avec créneaux, ${totalSlots} créneau(x) au total ` +
      `(${daysToScan.length} requêtes availability au lieu de ${totalSpan}).`,
  );
  console.log("\n✅ Scan live terminé (lecture seule — aucun booking).");
}

main().catch((e) => {
  console.error("Erreur:", e.message);
  process.exit(1);
});
