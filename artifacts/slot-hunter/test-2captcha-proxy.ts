/**
 * test-2captcha-proxy.ts — Test Cloudflare bypass avec proxy 2captcha (IP Espagne)
 *
 * Usage :
 *   CAPSOLVER_API_KEY=xxx PROXY_2CAPTCHA=http://user:pass@proxy.2captcha.com:port \
 *   npx tsx test-2captcha-proxy.ts
 *
 * Le proxy doit être un proxy résidentiel espagnol de https://2captcha.com/proxy
 * Format attendu : http://login:password@proxy.2captcha.com:8000
 * (ou socks5:// si fourni en SOCKS)
 */

const CAPSOLVER_KEY  = process.env.CAPSOLVER_API_KEY  ?? "";
const PROXY_URL      = process.env.PROXY_2CAPTCHA     ?? "";
const TARGET_URL     = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";

if (!CAPSOLVER_KEY) { console.error("❌  Manque CAPSOLVER_API_KEY"); process.exit(1); }
if (!PROXY_URL)     { console.error("❌  Manque PROXY_2CAPTCHA (ex: http://user:pass@proxy.2captcha.com:8000)"); process.exit(1); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalise le proxy en URL standard http://user:pass@host:port
 * Supporte deux formats :
 *   - standard :  http://user:pass@host:port
 *   - 2captcha  : http://host:port:user:pass  (ou juste host:port:user:pass)
 */
function normalizeProxyUrl(raw: string): string {
  const withScheme = raw.startsWith("http") ? raw : `http://${raw}`;
  try {
    const p = new URL(withScheme);
    // Format standard — a un @ dans l'URL
    if (p.username) return withScheme;
  } catch { /* pas valide, on parse manuellement */ }

  // Format 2captcha : http://host:port:user:pass
  const withoutScheme = withScheme.replace(/^https?:\/\//, "");
  const parts = withoutScheme.split(":");
  // parts = [host, port, user, pass]  (le user peut contenir des tirets mais pas de :)
  if (parts.length < 4) throw new Error(`Format proxy non reconnu: ${raw}`);
  const host = parts[0];
  const port = parts[1];
  const user = parts[2];
  const pass = parts.slice(3).join(":"); // au cas où le mot de passe contiendrait ":"
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

function proxyToCapsolverFormat(url: string): string {
  const normalized = normalizeProxyUrl(url);
  const p = new URL(normalized);
  const scheme = p.protocol.replace(":", "");
  return `${scheme}://${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}@${p.hostname}:${p.port}`;
}

async function checkBalance(): Promise<number | null> {
  const res = await fetch("https://api.capsolver.com/getBalance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CAPSOLVER_KEY }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json() as { errorId: number; balance?: number };
  if (data.errorId !== 0) return null;
  return data.balance ?? null;
}

// ─── Step 1 : vérifier le solde CapSolver ────────────────────────────────────

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  TEST : CapSolver AntiCloudflareTask + Proxy 2captcha");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
const PROXY_NORMALIZED = normalizeProxyUrl(PROXY_URL);
const PROXY_SAFE = PROXY_NORMALIZED.replace(/:([^:@]+)@/, ":<PASS>@");
console.log(`Proxy  : ${PROXY_SAFE}`);
console.log(`Cible  : ${TARGET_URL}`);
console.log("");

const balance = await checkBalance();
if (balance === null) { console.error("❌  CapSolver API key invalide ou réseau KO"); process.exit(1); }
console.log(`💰  Solde CapSolver : $${balance.toFixed(3)}`);
if (balance < 0.01) { console.error("❌  Solde insuffisant (< $0.01)"); process.exit(1); }

// ─── Step 2 : check IP du proxy avant solve ───────────────────────────────────

console.log("\n📍  Vérification de l'IP du proxy 2captcha…");
try {
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  const agent = new HttpsProxyAgent(PROXY_URL);
  const ipRes = await fetch("https://api.ipify.org?format=json", {
    // @ts-ignore — Node 18 fetch ne supporte pas agent directement, on passe par undici
    dispatcher: undefined,
  });
  // Fallback : utiliser curl si fetch ne supporte pas l'agent
  const { execSync } = await import("child_process");
  const curlOut = execSync(
    `curl -s --proxy "${PROXY_NORMALIZED}" "https://api.ipify.org?format=json" --max-time 15`,
    { encoding: "utf8" }
  );
  const ipData = JSON.parse(curlOut);
  console.log(`   IP proxy : ${ipData.ip}`);

  // Vérifier que l'IP est bien espagnole
  const geoOut = execSync(
    `curl -s "https://ipapi.co/${ipData.ip}/json/" --max-time 10`,
    { encoding: "utf8" }
  );
  const geo = JSON.parse(geoOut);
  console.log(`   Pays     : ${geo.country_name ?? "?"} (${geo.country_code ?? "?"})`);
  console.log(`   Ville    : ${geo.city ?? "?"} / ${geo.region ?? "?"}`);
  console.log(`   ASN      : ${geo.org ?? "?"}`);
  if (geo.country_code !== "ES") {
    console.warn(`⚠️   L'IP n'est PAS espagnole (${geo.country_code}) — le solve risque d'échouer sur citaconsular.es`);
  } else {
    console.log(`✅  IP espagnole confirmée`);
  }
} catch (err) {
  console.warn(`⚠️   Impossible de vérifier l'IP du proxy: ${err instanceof Error ? err.message : err}`);
}

// ─── Step 3 : AntiCloudflareTask via CapSolver ────────────────────────────────

console.log("\n🚀  Lancement AntiCloudflareTask…");
const proxyFmt = proxyToCapsolverFormat(PROXY_URL);
console.log(`   Proxy (CapSolver fmt) : ${proxyFmt.replace(/:([^:@]+)@/, ":<PASS>@")}`);

const t0 = Date.now();
const createRes = await fetch("https://api.capsolver.com/createTask", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    clientKey: CAPSOLVER_KEY,
    task: {
      type: "AntiCloudflareTask",
      websiteURL: TARGET_URL,
      proxy: proxyFmt,
    },
  }),
  signal: AbortSignal.timeout(30_000),
});
const createData = await createRes.json() as { errorId: number; taskId?: string; errorDescription?: string; errorCode?: string };

if (createData.errorId !== 0 || !createData.taskId) {
  console.error(`❌  createTask échoué: ${createData.errorDescription ?? createData.errorCode ?? `errorId=${createData.errorId}`}`);
  process.exit(1);
}
console.log(`✅  Task créée : ${createData.taskId}`);

// ─── Step 4 : Polling ─────────────────────────────────────────────────────────

console.log("⏳  Attente résultat (max 5min)…");
let cfClearance = "";
let userAgent = "";
let allCookies: Record<string, string> = {};

for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 5_000));

  const pollRes = await fetch("https://api.capsolver.com/getTaskResult", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId: createData.taskId }),
    signal: AbortSignal.timeout(15_000),
  });
  const poll = await pollRes.json() as {
    errorId: number; status?: string; errorCode?: string; errorDescription?: string;
    solution?: { cookies?: Record<string, string>; token?: string; userAgent?: string };
  };

  if (poll.errorId !== 0) {
    const code = poll.errorCode ?? `errorId=${poll.errorId}`;
    if (code.includes("ERROR_CAPTCHA_UNSOLVABLE") || code.includes("ERROR_PROXY")) {
      console.error(`❌  Erreur fatale: ${code}`);
      process.exit(1);
    }
    console.warn(`   Poll #${i+1} erreur non-fatale: ${code}`);
    continue;
  }
  if (poll.status === "failed") {
    console.error(`❌  Task failed: ${poll.errorDescription ?? poll.errorCode}`);
    process.exit(1);
  }
  if (poll.status === "ready" && poll.solution) {
    cfClearance = poll.solution.cookies?.["cf_clearance"] ?? poll.solution.token ?? "";
    userAgent   = poll.solution.userAgent ?? "";
    allCookies  = poll.solution.cookies ?? {};
    break;
  }
  if (i % 4 === 0) console.log(`   Poll #${i+1}/60 — en cours (${Math.round((Date.now()-t0)/1000)}s)`);
}

if (!cfClearance) {
  console.error("❌  Pas de cf_clearance dans la réponse (timeout ou solve raté)");
  process.exit(1);
}

const elapsed = Math.round((Date.now() - t0) / 1000);
console.log(`\n✅  SOLVE RÉUSSI en ${elapsed}s`);
console.log(`   cf_clearance : ${cfClearance.slice(0, 50)}…`);
console.log(`   User-Agent   : ${userAgent.slice(0, 80)}`);
console.log(`   Tous cookies : ${JSON.stringify(Object.keys(allCookies))}`);

// ─── Step 5 : Tester le cookie sur citaconsular.es ────────────────────────────

console.log("\n🔍  Test du cookie cf_clearance sur citaconsular.es…");

const cookieHeader = Object.entries(allCookies).map(([k,v]) => `${k}=${v}`).join("; ");
const widgetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";

// On utilise curl avec le proxy pour tester (même IP que le solve)
try {
  const { execSync } = await import("child_process");
  const curlCmd = [
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}|%{size_download}",
    "--proxy", PROXY_NORMALIZED,
    "-H", `"User-Agent: ${userAgent}"`,
    "-H", `"Cookie: ${cookieHeader}"`,
    "-H", '"Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"',
    "-H", '"Accept-Language: es-ES,es;q=0.9"',
    "--max-time", "20",
    `"${widgetUrl}"`,
  ].join(" ");

  const out = execSync(curlCmd, { encoding: "utf8" });
  const [status, size] = out.split("|");
  console.log(`   HTTP status  : ${status}`);
  console.log(`   Taille réponse : ${size} bytes`);

  if (status === "200" && parseInt(size) > 1000) {
    console.log("\n🎉  SUCCÈS ! Le cookie fonctionne avec l'IP 2captcha espagnole.");
    console.log("   → Cette configuration peut remplacer SOAX pour le scanner Espagne.\n");
  } else if (status === "403") {
    console.log("\n❌  403 — CF rejette le cookie (IP blacklistée ou cookie IP-mismatch)");
  } else if (status === "200" && parseInt(size) < 1000) {
    console.log("\n⚠️   200 mais réponse trop petite — possible challenge JS (vérifier manuellement)");
  } else {
    console.log(`\n⚠️   Status inattendu: ${status}`);
  }
} catch (err) {
  console.error(`❌  Erreur curl: ${err instanceof Error ? err.message : err}`);
}

// ─── Résumé ───────────────────────────────────────────────────────────────────

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("RÉSUMÉ :");
console.log(`  Proxy 2captcha (ES)  : ${PROXY_SAFE}`);
console.log(`  cf_clearance obtenu  : ${cfClearance ? "✅ OUI" : "❌ NON"}`);
console.log(`  Durée solve          : ${elapsed}s`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
