/**
 * dump-cf-challenge-html.ts — Dump le HTML du challenge CF via Impit pour analyser le format
 */
import "dotenv/config";
import { Impit } from "impit";

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

async function main(): Promise<void> {
  const proxyUrl = process.env.SPAIN_ISP_PROXY_URL ?? process.env.DECODO_PROXY_URL;
  if (!proxyUrl) {
    // Fallback CSV
    const fs = require("node:fs");
    const path = require("node:path");
    try {
      const csv = fs.readFileSync(path.join(process.cwd(), "decodo-proxies.csv"), "utf8");
      const [host, port, user, pass] = csv.trim().split("\n")[0].split(":");
      process.env.SPAIN_ISP_PROXY_URL = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    } catch { /* */ }
  }

  const proxy = process.env.SPAIN_ISP_PROXY_URL;
  console.log(`Proxy: ${proxy?.replace(/:([^@:]+)@/, ":***@") ?? "direct"}`);

  const impit = new Impit({ browser: "chrome", proxyUrl: proxy || undefined } as any);
  const resp = await impit.fetch(SAOPOLO_URL, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9",
    },
  } as any) as unknown as Response;

  const html = await resp.text();
  console.log(`HTTP ${resp.status} | ${html.length}B\n`);
  console.log("═".repeat(72));
  console.log(html);
  console.log("═".repeat(72));

  // Analyse spécifique
  console.log("\n── ANALYSE ──");
  console.log(`challenges.cloudflare.com: ${(html.match(/challenges\.cloudflare\.com[^"'\s]*/g) ?? []).join("\n  ")}`);
  console.log(`_cf_chl_opt: ${html.includes("_cf_chl_opt") ? "OUI" : "NON"}`);
  console.log(`turnstile: ${html.includes("turnstile") ? "OUI" : "NON"}`);
  console.log(`data-sitekey: ${(html.match(/data-sitekey="([^"]+)"/g) ?? []).join(", ") || "NON"}`);
  console.log(`sitekey patterns: ${(html.match(/[0-9]x[0-9a-fA-F]{20,}/g) ?? []).join(", ") || "aucun"}`);
  console.log(`cRay/ray: ${(html.match(/cRay['"]?\s*[:=]\s*['"]([^'"]+)['"]/g) ?? []).join(", ")}`);
  console.log(`challenge-form: ${html.includes("challenge-form") ? "OUI" : "NON"}`);

  // Extraire tous les scripts src
  const scripts = html.match(/<script[^>]*src="([^"]+)"[^>]*>/gi) ?? [];
  console.log(`\nScripts src (${scripts.length}):`);
  for (const s of scripts) console.log(`  ${s.slice(0, 150)}`);

  // Extraire le contenu des scripts inline
  const inlineScripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  console.log(`\nScripts inline (${inlineScripts.length}):`);
  for (const s of inlineScripts) {
    const content = s.replace(/<\/?script[^>]*>/gi, "").trim();
    if (content.length > 10) console.log(`  [${content.length}c] ${content.slice(0, 200)}`);
  }
}

main().catch(console.error);
