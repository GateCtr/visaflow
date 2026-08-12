/**
 * test-soax-asis.ts — Run ensureSpainCfSession + spainCfFetch as-is
 */
import "dotenv/config";
import { ensureSpainCfSession, spainCfFetch } from "../spain-soax-solver.js";

async function main(): Promise<void> {
  console.log("Running ensureSpainCfSession()...");
  const s = await ensureSpainCfSession();
  if (!s) {
    console.log("SESSION FAILED — null returned");
    process.exit(1);
  }

  console.log("SESSION OK:");
  console.log("  source:", s.source);
  console.log("  cfClearance:", s.cfClearance?.slice(0, 30) + "…");
  console.log("  UA:", s.userAgent?.slice(0, 60));
  console.log("  proxy:", s.soaxProxyUrl?.replace(/:([^@:]+)@/, ":***@").slice(0, 60));

  // Test spainCfFetch on /main/
  const ts = Date.now();
  const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
  const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?callback=jQ_${ts}&type=default&publickey=2d01502f12dc08400e22aea87fb00ae34&lang=es&version=4&src=${encodeURIComponent(portalUrl)}&_=${ts + 1}`;

  console.log("\nTesting spainCfFetch on /main/...");
  try {
    const r = await spainCfFetch(mainUrl, s, {
      method: "GET",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Referer": portalUrl,
        "Accept": "text/javascript, application/javascript, */*; q=0.01",
      },
    });
    const body = await r!.text();
    console.log(`/main/ → ${r!.status} | ${body.length}B`);
    if (body.length > 100) {
      console.log("BODY[0:200]:", body.slice(0, 200));
    }
  } catch (err: any) {
    console.error("spainCfFetch error:", err.message);
  }
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
