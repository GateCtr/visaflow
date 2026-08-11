#!/usr/bin/env node
/**
 * test-pool-cf-challenge.ts — Sonde chaque IP du pool CSV Decodo
 *
 * Pour chaque ligne du CSV, fait un GET impit sur le portal citaconsular.es
 * et classifie le challenge CF reçu :
 *
 *   DIRECT      → 200, pas de challenge (accès libre)
 *   JSD         → __CF$cv$params présent (solvable par impit seul)
 *   TURNSTILE   → _cf_chl_opt + sitekey visible (solvable CapSolver AntiTurnstile + impit POST)
 *   INTERACTIVE → cType:'interactive', pas de sitekey (CapSolver Chrome uniquement)
 *   BLOCKED     → 403/429 sans challenge reconnu, ou autre erreur
 *
 * Usage : node_modules/.bin/tsx scripts/test-pool-cf-challenge.ts
 */

import { Impit } from "impit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PORTAL_URL =
  process.env.SPAIN_WIDGET_URL ||
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

const CSV_PATH = process.env.DECODO_PROXY_FILE ?? resolve(process.cwd(), "decodo-proxies.csv");

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// ─── Parse CSV ───────────────────────────────────────────────────────────────

function parseCsv(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  const urls: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Format http://user:pass@host:port
    if (line.startsWith("http")) {
      urls.push(line);
      continue;
    }

    // Format host:port:user:pass  (Decodo CSV)
    const parts = line.split(":");
    if (parts.length >= 4) {
      const [host, port, user, ...passParts] = parts;
      const pass = passParts.join(":"); // mot de passe peut contenir '='
      urls.push(`http://${user}:${encodeURIComponent(pass)}@${host}:${port}`);
    }
  }
  return urls;
}

// ─── Classify CF response ─────────────────────────────────────────────────────

type ChallengeType = "DIRECT" | "JSD" | "TURNSTILE" | "INTERACTIVE" | "BLOCKED" | "ERROR";

interface ProbeResult {
  proxyUrl: string;
  label: string;
  status: number;
  bodyLen: number;
  challenge: ChallengeType;
  cType: string;
  sitekey: string;
  phpsessid: string;
  token: string;           // CSRF token sur la page "Continue"
  elapsedMs: number;
}

function classify(status: number, body: string): {
  challenge: ChallengeType; cType: string; sitekey: string;
} {
  const head = body.slice(0, 5000);

  if (status === 200 && !/just a moment|_cf_chl_opt|__CF\$cv\$params/i.test(head)) {
    return { challenge: "DIRECT", cType: "", sitekey: "" };
  }

  if (/window\.__CF\$cv\$params/.test(head)) {
    return { challenge: "JSD", cType: "jsd", sitekey: "" };
  }

  // Managed challenge : chercher cType et sitekey
  const cTypeM = head.match(/["']cType["']\s*:\s*["']([^"']+)["']/);
  const cType = cTypeM?.[1] ?? "";

  const skM =
    head.match(/challenges\.cloudflare\.com\/turnstile\/v[\d]+\/[a-z]\/([a-f0-9]{8,32})\/api\.js/) ??
    head.match(/data-sitekey="([a-zA-Z0-9_\-]{8,64})"/) ??
    head.match(/["']cH["']\s*:\s*["']([a-f0-9]{8,32})["']/);
  const sitekey = skM?.[1] ?? "";

  if (/_cf_chl_opt|challenges\.cloudflare\.com/i.test(head)) {
    if (sitekey) return { challenge: "TURNSTILE", cType, sitekey };
    return { challenge: "INTERACTIVE", cType: cType || "interactive", sitekey: "" };
  }

  return { challenge: "BLOCKED", cType: "", sitekey: "" };
}

// ─── Probe one proxy ──────────────────────────────────────────────────────────

async function probe(proxyUrl: string, index: number): Promise<ProbeResult> {
  const t0 = Date.now();
  const label = `IP#${String(index + 1).padStart(2, "0")}`;
  const masked = proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 70);

  try {
    const imp = new Impit({ browser: "chrome", proxyUrl } as any);
    const res = await (imp.fetch(PORTAL_URL, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
    } as any) as unknown as Response);

    const body = await res.text();
    const status = (res as any).status as number;
    const elapsedMs = Date.now() - t0;

    const setCookie = (res as any).headers?.get?.("set-cookie") ?? "";
    const phpsessid = setCookie.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";

    // Token CSRF (page "Continue")
    const tokenM = body.match(/<input[^>]+name=["']token["'][^>]+value=["']([^"']+)["']/i);
    const token = tokenM?.[1] ?? "";

    const { challenge, cType, sitekey } = classify(status, body);

    return { proxyUrl, label, status, bodyLen: body.length, challenge, cType, sitekey, phpsessid, token, elapsedMs };
  } catch (err) {
    return {
      proxyUrl, label, status: 0, bodyLen: 0,
      challenge: "ERROR", cType: "", sitekey: "",
      phpsessid: "", token: "",
      elapsedMs: Date.now() - t0,
    };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let proxies: string[];
  try {
    proxies = parseCsv(CSV_PATH);
  } catch (e) {
    console.error(`❌ Impossible de lire ${CSV_PATH}: ${e}`);
    process.exit(1);
  }

  if (proxies.length === 0) {
    console.error("❌ Aucune IP dans le CSV");
    process.exit(1);
  }

  console.log("=".repeat(70));
  console.log(`  PROBE POOL DECODO — ${proxies.length} IPs — ${PORTAL_URL.slice(0, 60)}`);
  console.log("=".repeat(70));
  console.log("  Probing toutes les IPs en parallèle…\n");

  // Parallèle — toutes les IPs en même temps
  const results = await Promise.all(proxies.map((url, i) => probe(url, i)));

  // ── Affichage ────────────────────────────────────────────────────────────
  const icon: Record<ChallengeType, string> = {
    DIRECT:      "✅",
    JSD:         "🟡",
    TURNSTILE:   "🟠",
    INTERACTIVE: "🔴",
    BLOCKED:     "⛔",
    ERROR:       "💥",
  };

  console.log(`${"─".repeat(70)}`);
  console.log(
    `${"Label".padEnd(8)} ${"Challenge".padEnd(12)} ${"cType".padEnd(14)} ${"Status".padEnd(7)} ` +
    `${"Body".padEnd(7)} ${"PHPSESSID".padEnd(10)} ${"Token".padEnd(8)} ${"ms".padEnd(6)}`
  );
  console.log(`${"─".repeat(70)}`);

  for (const r of results) {
    const ic = icon[r.challenge];
    const sk = r.sitekey ? ` sk=${r.sitekey.slice(0, 8)}…` : "";
    const php = r.phpsessid ? r.phpsessid.slice(0, 8) + "…" : "absent";
    const tok = r.token ? "✅" : "—";
    console.log(
      `${ic} ${r.label.padEnd(6)} ${r.challenge.padEnd(12)} ${(r.cType + sk).slice(0, 14).padEnd(14)} ` +
      `${String(r.status).padEnd(7)} ${String(r.bodyLen).padEnd(7)} ${php.padEnd(10)} ${tok.padEnd(8)} ${r.elapsedMs}ms`
    );
  }

  console.log(`\n${"─".repeat(70)}`);

  // ── Résumé par type ───────────────────────────────────────────────────────
  const counts: Record<ChallengeType, number> = {
    DIRECT: 0, JSD: 0, TURNSTILE: 0, INTERACTIVE: 0, BLOCKED: 0, ERROR: 0,
  };
  for (const r of results) counts[r.challenge]++;

  console.log("\n  RÉSUMÉ :");
  console.log(`    ✅ DIRECT      : ${counts.DIRECT} IP(s) — accès libre, PHPSESSID dispo direct`);
  console.log(`    🟡 JSD         : ${counts.JSD} IP(s) — solvable par impit seul (JSDSolver)`);
  console.log(`    🟠 TURNSTILE   : ${counts.TURNSTILE} IP(s) — CapSolver AntiTurnstile + impit POST → cf_clearance impit`);
  console.log(`    🔴 INTERACTIVE : ${counts.INTERACTIVE} IP(s) — CapSolver Chrome only (cf_clearance non transférable)`);
  console.log(`    ⛔ BLOCKED     : ${counts.BLOCKED} IP(s) — accès refusé`);
  console.log(`    💥 ERROR       : ${counts.ERROR} IP(s) — erreur réseau/proxy`);

  const good = counts.DIRECT + counts.JSD + counts.TURNSTILE;
  const bad  = counts.INTERACTIVE + counts.BLOCKED + counts.ERROR;
  console.log(`\n  IPs utilisables avec impit HTTP: ${good}/${proxies.length}`);
  console.log(`  IPs inutilisables (challenge interactif/blocked): ${bad}/${proxies.length}`);

  if (counts.DIRECT > 0) {
    console.log("\n  ⚡ Bonnes nouvelles : des IPs DIRECT existent → aucun solve nécessaire pour ces IPs");
  }
  if (counts.JSD + counts.TURNSTILE > 0) {
    console.log("  ✅ Des IPs avec challenges solvables par impit → flow hybride possible");
  }
  if (good === 0) {
    console.log("\n  ⚠️  Aucune IP utilisable avec impit → fallback browser obligatoire");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
