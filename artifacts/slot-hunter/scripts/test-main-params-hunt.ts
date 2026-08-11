#!/usr/bin/env node
/**
 * Cherche les params exact qui font retourner les données de /main/.
 * Teste de nombreuses variantes : srvsrc inclus, version=2, path-based, POST, etc.
 */

const PORTAL  = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const WID     = "2d01502f12dc08400e22aea87fb00ae34";
const BASE    = "https://www.citaconsular.es/onlinebookings/";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const PROXY   = process.env.SOAX_PROXY_URL ?? "";

// Utilise un fetch sans proxy via ProxyAgent si disponible, sinon direct
async function req(url: string, init: RequestInit = {}, label = ""): Promise<[number, string, string]> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const b = await r.text();
    const ct = r.headers.get("content-type") ?? "";
    const isErr  = /Exception|Contact with your technical|no callback found/i.test(b.slice(0, 300));
    const hasData = b.length > 200 && !isErr;
    const mark = hasData ? "🎉" : isErr ? "⚠️ " : b.length === 0 ? "0B" : "?  ";
    console.log(`${mark} [${label}] ${r.status} | ${b.length}B | ${ct.slice(0, 30)}`);
    if (b.length > 0 && b.length < 600) console.log(`     "${b.slice(0, 300).replace(/\s+/g, " ").trim()}"`);
    return [r.status, b, ct];
  } catch (e) {
    console.log(`❌ [${label}] ${e}`);
    return [0, "", ""];
  }
}

function cb() { return `jQuery${Date.now()}_${Math.floor(Math.random() * 9999)}`; }

async function main() {
  // Récupérer la vraie réponse /main/ depuis le vrai bookitit.com pour comparer
  console.log("\n══════════ BASELINE : webapp.bookitit.com ══════════");
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, type: "default", publickey: WID, lang: "es", version: "4", src: PORTAL, _: String(Date.now()) });
    await req(`https://webapp.bookitit.com/onlinebookings/main/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL } }, "webapp.bkt.com /main/ avec src");
  }
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, type: "default", publickey: WID, lang: "es", version: "4", _: String(Date.now()) });
    await req(`https://webapp.bookitit.com/onlinebookings/main/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL } }, "webapp.bkt.com /main/ sans src");
  }

  console.log("\n══════════ citaconsular.es — variantes params ══════════");

  // A: avec srvsrc dans les params
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, type: "default", publickey: WID, lang: "es", version: "4", srvsrc: "https://www.citaconsular.es", src: PORTAL, _: String(Date.now()) });
    await req(`${BASE}main/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL } }, "cita /main/ avec srvsrc");
  }

  // B: version=2 (iframe mode)
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, type: "default", publickey: WID, lang: "es", version: "2", src: PORTAL, _: String(Date.now()) });
    await req(`${BASE}main/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL } }, "cita /main/ version=2");
  }

  // C: type=iframe
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, type: "iframe", publickey: WID, lang: "es", version: "4", src: PORTAL, _: String(Date.now()) });
    await req(`${BASE}main/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL } }, "cita /main/ type=iframe");
  }

  // D: callback=? littéral (jQuery pré-replacement)
  {
    await req(`${BASE}main/?callback=%3F&type=default&publickey=${WID}&lang=es&version=4&src=${encodeURIComponent(PORTAL)}&_=${Date.now()}`,
      { headers: { "User-Agent": UA, "Referer": PORTAL } }, "cita /main/ callback=?");
  }

  // E: format callback jQuery21305...
  {
    const c = `jQuery21305${Date.now()}_${Math.floor(Math.random() * 99999)}`;
    const q = new URLSearchParams({ callback: c, type: "default", publickey: WID, lang: "es", version: "4", src: PORTAL, _: String(Date.now()) });
    await req(`${BASE}main/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL } }, "cita /main/ callback jQuery21305...");
  }

  // F: POST à /main/ au lieu de GET
  {
    const c = cb();
    const body = new URLSearchParams({ callback: c, type: "default", publickey: WID, lang: "es", version: "4", src: PORTAL, _: String(Date.now()) }).toString();
    await req(`${BASE}main/`, {
      method: "POST",
      headers: { "User-Agent": UA, "Referer": PORTAL, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, "cita /main/ POST");
  }

  // G: publickey dans le PATH
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, lang: "es", version: "4", src: PORTAL, _: String(Date.now()) });
    await req(`${BASE}main/${WID}/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL } }, "cita /main/<pk>/ path-based");
  }

  // H: sans aucun param (juste callback)
  {
    const c = cb();
    await req(`${BASE}main/?callback=${c}`, { headers: { "User-Agent": UA } }, "cita /main/ callback seulement");
  }

  // I: Referer = citaconsular.es (root)
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, type: "default", publickey: WID, lang: "es", version: "4", src: PORTAL, _: String(Date.now()) });
    await req(`${BASE}main/?${q}`, { headers: { "User-Agent": UA, "Referer": "https://www.citaconsular.es/" } }, "cita /main/ Referer=root");
  }

  // J: Sans User-Agent (pure)
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, type: "default", publickey: WID, lang: "es", version: "4", _: String(Date.now()) });
    await req(`${BASE}main/?${q}`, {}, "cita /main/ sans UA ni Referer");
  }

  // K: getwidgetconfigurations sans PHPSESSID
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, publickey: WID, lang: "es", _: String(Date.now()) });
    await req(`${BASE}getwidgetconfigurations/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL } }, "cita /getwidgetconfigurations/");
  }

  // L: getservices sans PHPSESSID
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, publickey: WID, lang: "es", _: String(Date.now()) });
    await req(`${BASE}getservices/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL } }, "cita /getservices/");
  }

  // M: Directement depuis bookitit API v2
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, type: "default", publickey: WID, lang: "es", version: "4", srvsrc: "https://www.citaconsular.es", _: String(Date.now()) });
    await req(`https://www.bookitit.com/onlinebookings/main/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL } }, "www.bookitit.com /main/");
  }

  // N: Essai avec Origin header
  {
    const c = cb();
    const q = new URLSearchParams({ callback: c, type: "default", publickey: WID, lang: "es", version: "4", src: PORTAL, _: String(Date.now()) });
    await req(`${BASE}main/?${q}`, { headers: { "User-Agent": UA, "Referer": PORTAL, "Origin": "https://www.citaconsular.es" } }, "cita /main/ avec Origin");
  }

  // O: Essai avec un autre WID (Kinshasa? Chercher dans le code)
  // Tester avec un WID factice pour voir si l'erreur change
  {
    const c = cb();
    const testWid = "abcdef1234567890abcdef1234567890";
    const q = new URLSearchParams({ callback: c, type: "default", publickey: testWid, lang: "es", version: "4", _: String(Date.now()) });
    await req(`${BASE}main/?${q}`, { headers: { "User-Agent": UA } }, "cita /main/ WID factice");
  }

  console.log("\n══════════ Résumé ══════════");
  console.log("🎉 = données widget (succès)");
  console.log("⚠️  = erreur JSON/JSONP server");
  console.log("0B = body vide (HTML 0B)");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
