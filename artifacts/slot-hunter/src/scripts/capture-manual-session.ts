/**
 * capture-manual-session.ts — Lance un navigateur VISIBLE sur le portail Sao Paulo.
 * Toi tu navigues manuellement (résous CF, clique Continuar, etc.).
 * Le script capture TOUT en arrière-plan :
 *   - Chaque requête (method, URL, headers, body)
 *   - Chaque réponse (status, headers, body size, body content pour les API)
 *   - Cookies à chaque étape
 *   - Séquence et timing
 *   - Événements réseau (request, response, requestfailed)
 *
 * USAGE:
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/capture-manual-session.ts
 *
 * Le dump est écrit en continu dans dump/manual-capture-{timestamp}.json
 * Ctrl+C pour arrêter proprement (sauvegarde finale).
 */
import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Protocol } from "devtools-protocol";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

puppeteer.use(StealthPlugin());

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const DUMP_DIR = join(process.cwd(), "dump");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const DUMP_FILE = join(DUMP_DIR, `manual-capture-${TIMESTAMP}.json`);

interface CapturedRequest {
  seq: number;
  ts: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestPostData?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBodySize?: number;
  responseBodyPreview?: string; // first 2000 chars for API responses
  responseMimeType?: string;
  timing?: { startMs: number; endMs?: number; durationMs?: number };
  cookies?: string;
  error?: string;
  triggeredBy?: string; // "navigation" | "xmlhttprequest" | "script" | "fetch" etc.
}

const captured: CapturedRequest[] = [];
let seq = 0;
const T0 = Date.now();
const pendingRequests = new Map<string, CapturedRequest>();

function save(): void {
  try {
    mkdirSync(DUMP_DIR, { recursive: true });
    writeFileSync(DUMP_FILE, JSON.stringify({
      description: "Manual browser capture — Sao Paulo portal",
      generatedAt: new Date().toISOString(),
      portalUrl: SAOPOLO_URL,
      totalRequests: captured.length,
      flow: captured,
    }, null, 2));
  } catch (e) {
    // ignore write errors
  }
}

// Auto-save every 5 seconds
setInterval(save, 5000);

async function main(): Promise<void> {
  console.log("═".repeat(70));
  console.log("  CAPTURE MANUELLE — Navigateur visible");
  console.log("  Tu navigues, je capture tout.");
  console.log("═".repeat(70));
  console.log(`  Portail : ${SAOPOLO_URL}`);
  console.log(`  Dump    : ${DUMP_FILE}`);
  console.log(`  Stop    : Ctrl+C (sauvegarde automatique)\n`);

  const browser = await (puppeteer as any).launch({
    headless: false,
    defaultViewport: null,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--lang=es-ES",
    ],
  });

  const page = (await browser.pages())[0] || await browser.newPage();

  // Enable CDP for detailed network interception
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable", {
    maxTotalBufferSize: 50 * 1024 * 1024,
    maxResourceBufferSize: 10 * 1024 * 1024,
  });

  // ── Request intercepted ──
  cdp.on("Network.requestWillBeSent", (params: Protocol.Network.RequestWillBeSentEvent) => {
    const entry: CapturedRequest = {
      seq: ++seq,
      ts: new Date().toISOString(),
      method: params.request.method,
      url: params.request.url,
      resourceType: params.type ?? "unknown",
      requestHeaders: params.request.headers as Record<string, string>,
      requestPostData: params.request.postData ?? undefined,
      timing: { startMs: Date.now() - T0 },
      triggeredBy: params.initiator?.type ?? "unknown",
    };
    pendingRequests.set(params.requestId, entry);
    captured.push(entry);

    // Log en temps réel
    const shortUrl = entry.url.length > 100 ? entry.url.slice(0, 100) + "…" : entry.url;
    const postInfo = entry.requestPostData ? ` [body: ${entry.requestPostData.length}B]` : "";
    console.log(`  → #${entry.seq} ${entry.method} ${shortUrl}${postInfo} (${entry.triggeredBy})`);
  });

  // ── Response received ──
  cdp.on("Network.responseReceived", async (params: Protocol.Network.ResponseReceivedEvent) => {
    const entry = pendingRequests.get(params.requestId);
    if (!entry) return;

    entry.responseStatus = params.response.status;
    entry.responseHeaders = params.response.headers as Record<string, string>;
    entry.responseMimeType = params.response.mimeType;
    entry.timing = entry.timing ?? { startMs: 0 };
    entry.timing.endMs = Date.now() - T0;
    entry.timing.durationMs = (entry.timing.endMs ?? 0) - entry.timing.startMs;

    // Log
    console.log(`  ← #${entry.seq} ${entry.responseStatus} | ${entry.responseMimeType} (${entry.timing.durationMs}ms)`);
  });

  // ── Response body (pour les API/JSONP) ──
  cdp.on("Network.loadingFinished", async (params: Protocol.Network.LoadingFinishedEvent) => {
    const entry = pendingRequests.get(params.requestId);
    if (!entry) return;

    entry.responseBodySize = params.encodedDataLength;

    // Capturer le body pour les requêtes API intéressantes
    const isApi = entry.url.includes("/onlinebookings/") ||
      entry.url.includes("getservices") ||
      entry.url.includes("getagendas") ||
      entry.url.includes("datetime") ||
      entry.url.includes("getwidgetconfigurations") ||
      entry.url.includes("main/") ||
      entry.url.includes("signin") ||
      entry.url.includes("signup") ||
      entry.url.includes("summary") ||
      (entry.responseMimeType?.includes("javascript") && entry.url.includes("callback="));
    
    const isHtmlPage = entry.responseMimeType?.includes("html") && entry.method === "POST";

    if (isApi || isHtmlPage) {
      try {
        const body = await cdp.send("Network.getResponseBody", { requestId: params.requestId });
        const content = body.base64Encoded
          ? Buffer.from(body.body, "base64").toString("utf-8")
          : body.body;
        entry.responseBodyPreview = content.slice(0, 5000);
        entry.responseBodySize = content.length;

        // Log body info
        const marker = content.length > 1000 ? "✅" : content.length === 0 ? "❌ 0B" : "⚠️";
        console.log(`     ${marker} Body: ${content.length}B | ${content.slice(0, 80).replace(/\n/g, " ")}`);
      } catch {
        // body not available
      }
    }

    pendingRequests.delete(params.requestId);
  });

  // ── Request failed ──
  cdp.on("Network.loadingFailed", (params: Protocol.Network.LoadingFailedEvent) => {
    const entry = pendingRequests.get(params.requestId);
    if (entry) {
      entry.error = params.errorText;
      console.log(`  ✗ #${entry.seq} FAILED: ${params.errorText}`);
      pendingRequests.delete(params.requestId);
    }
  });

  // ── Capture cookies après chaque navigation ──
  page.on("framenavigated", async () => {
    try {
      const cookies = await page.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value.slice(0, 20)}`).join("; ");
      console.log(`  🍪 Cookies: ${cookieStr.slice(0, 200)}`);
      // Attach to the last captured request
      if (captured.length > 0) {
        captured[captured.length - 1].cookies = cookies.map(c => `${c.name}=${c.value}`).join("; ");
      }
    } catch { /* ignore */ }
  });

  // Navigate to portal
  console.log("\n  🌐 Navigation vers le portail...\n");
  await page.goto(SAOPOLO_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  console.log("\n  ✅ Page chargée. Navigue manuellement maintenant !");
  console.log("  📝 Je capture tout en arrière-plan.");
  console.log("  ⏹️  Ctrl+C quand tu as terminé.\n");

  // Keep alive until Ctrl+C
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log("\n\n  ⏹️  Arrêt demandé — sauvegarde finale...");
      save();
      console.log(`  💾 ${captured.length} requêtes capturées → ${DUMP_FILE}`);
      resolve();
    });
    // Also handle browser close
    browser.on("disconnected", () => {
      console.log("\n  🔌 Browser fermé — sauvegarde...");
      save();
      console.log(`  💾 ${captured.length} requêtes capturées → ${DUMP_FILE}`);
      resolve();
    });
  });

  try { await browser.close(); } catch { /* already closed */ }
  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
