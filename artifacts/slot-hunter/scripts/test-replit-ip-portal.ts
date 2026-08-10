#!/usr/bin/env node
/**
 * test-replit-ip-portal.ts
 * Probe le portail citaconsular.es SANS proxy (IP directe de Replit)
 * pour voir si CF challenge ou accès direct → PHPSESSID ?
 */
import { Impit } from "impit";

const PORTAL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BASE   = "https://www.citaconsular.es/onlinebookings/";
const WID    = "2d01502f12dc08400e22aea87fb00ae34";
const UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

async function main() {
  // IP Replit
  const ipRes = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(8000) });
  const { ip } = await ipRes.json() as any;
  console.log("IP Replit (sans proxy):", ip);

  const imp = new Impit({ browser: "chrome" } as any);

  // ── GET portal sans proxy ──────────────────────────────────────────────────
  console.log("\n── GET portal (sans proxy) …");
  const res = await (imp.fetch(PORTAL, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
    },
  } as any) as unknown as Response);

  const body       = await res.text();
  const status     = (res as any).status as number;
  const setCookie  = (res as any).headers?.get?.("set-cookie") ?? "";
  const phpSessId  = setCookie.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
  const isCf       = /just a moment|_cf_chl_opt|challenge-platform/i.test(body.slice(0, 3000));
  const cTypeM     = body.match(/["']cType["']\s*:\s*["']([^"']+)["']/);
  const hasJsd     = /window\.__CF\$cv\$params/.test(body);
  const hasTurnstile = /challenges\.cloudflare\.com\/turnstile/i.test(body);
  const tokenM     = body.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i);

  console.log(`  HTTP ${status} | ${body.length}B`);
  console.log(`  CF challenge : ${isCf ? "🔴 OUI" : "✅ NON (accès direct!)"}`);
  if (isCf) {
    console.log(`  cType        : ${cTypeM?.[1] ?? "inconnu"}`);
    console.log(`  JSD          : ${hasJsd ? "OUI" : "non"}`);
    console.log(`  Turnstile    : ${hasTurnstile ? "OUI" : "non"}`);
  }
  console.log(`  PHPSESSID    : ${phpSessId ? "✅ " + phpSessId.slice(0, 12) + "…" : "absent"}`);
  console.log(`  Token CSRF   : ${tokenM?.[1] ? tokenM[1].slice(0, 20) + "…" : "absent"}`);

  if (!isCf && phpSessId) {
    // ── POST Continuar ─────────────────────────────────────────────────────
    const token = tokenM?.[1] ?? "";
    const formM = body.match(/<form[^>]+action=["']([^"']+)["'][^>]+method=["']POST["']/i);
    const postUrl = formM?.[1]
      ? (formM[1].startsWith("http") ? formM[1] : `https://www.citaconsular.es${formM[1]}`)
      : PORTAL + "/";

    console.log(`\n── POST Continuar → ${postUrl}`);
    const jar: Record<string, string> = { PHPSESSID: phpSessId };
    const postRes = await (imp.fetch(postUrl, {
      method: "POST",
      headers: {
        "User-Agent": UA, "Cookie": `PHPSESSID=${phpSessId}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": PORTAL, "Origin": "https://www.citaconsular.es",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1",
      },
      body: `token=${encodeURIComponent(token)}`,
    } as any) as unknown as Response);

    const postBody   = await postRes.text();
    const postStatus = (res as any).status as number;
    const postSetCookie = (postRes as any).headers?.get?.("set-cookie") ?? "";
    const newPhp = postSetCookie.match(/PHPSESSID=([^;]+)/)?.[1] ?? phpSessId;
    if (newPhp !== phpSessId) jar["PHPSESSID"] = newPhp;

    console.log(`  HTTP ${postStatus} | ${postBody.length}B`);

    // ── GET /main/ ─────────────────────────────────────────────────────────
    console.log(`\n── GET ${BASE}main/ avec PHPSESSID …`);
    const cbName = `jQuery${Date.now()}`;
    const q = new URLSearchParams({
      callback: cbName, type: "default", publickey: WID,
      lang: "es", version: "4", src: PORTAL, _: String(Date.now()),
    });
    const mainUrl = `${BASE}main/?${q}`;
    const mainRes = await (imp.fetch(mainUrl, {
      headers: {
        "User-Agent": UA, "Cookie": `PHPSESSID=${jar["PHPSESSID"]}`,
        "Accept": "*/*", "Referer": PORTAL,
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
    } as any) as unknown as Response);

    const mainBody   = await mainRes.text();
    const mainStatus = (mainRes as any).status as number;
    const isBkt      = /bkt_init_widget|bkt_widget_init/i.test(mainBody);
    const isCfMain   = /just a moment|_cf_chl_opt/i.test(mainBody.slice(0, 2000));
    const isJsonp    = mainBody.startsWith(cbName) || /jQuery\d+\s*\(/.test(mainBody.slice(0, 30));

    console.log(`  HTTP ${mainStatus} | ${mainBody.length}B | CF:${isCfMain ? "🔴" : "✅"} bkt:${isBkt ? "✅" : "—"} JSONP:${isJsonp ? "✅" : "—"}`);
    if (mainBody.length > 0) console.log(`  Preview: "${mainBody.slice(0, 250).replace(/\s+/g, " ").trim()}"`);

    if (mainBody.length > 100 && !isCfMain) {
      console.log("\n✅✅ FLOW COMPLET VALIDÉ — IP Replit passe CF, /main/ retourne des données!");
    }
  } else if (isCf) {
    console.log("\n❌ IP Replit reçoit aussi un CF challenge");
    console.log("   → Toutes les IPs disponibles sont challengées de façon interactive");
    console.log("   → Solution : extraire PHPSESSID depuis CapSolver Chrome (CDP)");
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
