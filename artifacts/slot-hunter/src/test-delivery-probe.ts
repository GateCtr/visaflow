/**
 * test-delivery-probe.ts — Probe les endpoints docDelivery sur un RDV existant
 * Se connecte au portail USA et appelle les endpoints delivery pour extraire
 * les données réelles (lieu de retrait passeport, type, etc.)
 *
 * Usage : npx tsx src/test-delivery-probe.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { loginUsaPortal, setUsaSessionProxy } from "./usaPortal.js";

const EMAIL    = process.env.USA_EMAIL ?? "";
const PASSWORD = process.env.USA_PASSWORD ?? "";
if (!EMAIL || !PASSWORD) { console.error("USA_EMAIL + USA_PASSWORD requis"); process.exit(1); }

const BASE = "https://www.usvisaappt.com";
const MISSION_ID = 323;

// IDs connus depuis la capture Playwright
const APPLICATION_ID = "fa68-6780-e96e-c8eb";
const APPLICANT_ID_GSS = "RQUP3HHVQHOD";

async function probe(label: string, url: string, headers: Record<string, string>, method = "GET", body?: string): Promise<unknown> {
  try {
    const r = await fetch(url, { method, headers, body });
    const txt = await r.text();
    const ico = r.ok ? "✅" : r.status === 404 ? "🔍" : r.status >= 500 ? "⚠️" : "❌";
    console.log(`\n${ico} [${r.status}] ${label}`);
    if (txt) {
      try {
        const json = JSON.parse(txt);
        console.log(JSON.stringify(json, null, 2));
        return json;
      } catch {
        console.log(`   ${txt.slice(0, 500)}`);
      }
    }
    return null;
  } catch (err) { console.log(`💥 ${label}: ${err}`); return null; }
}

async function main(): Promise<void> {
  console.log("═".repeat(65));
  console.log("  PROBE DELIVERY ENDPOINTS — Extraction données réelles");
  console.log("═".repeat(65));

  setUsaSessionProxy(process.env.IPROYAL_PROXY_URL);
  const s = await loginUsaPortal(EMAIL, PASSWORD);
  if (!s) { console.error("Login failed"); process.exit(1); }

  console.log(`✅ Login: ${s.fullName} (userID=${s.userID})\n`);

  const hdr: Record<string, string> = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Authorization": `Bearer ${s.accessToken}`,
    "Content-Type": "application/json",
    "Origin": BASE,
    "Referer": `${BASE}/visaapplicantui/home/dashboard`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Liste des lieux de retrait pour la mission Kinshasa
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(65));
  console.log("  1. GET deliverymission/config/missionId/323");
  console.log("     → Liste de TOUS les lieux de retrait disponibles");
  console.log("─".repeat(65));
  await probe(
    "deliverymission/config/missionId/323",
    `${BASE}/visaadministrationapi/v1/deliverymission/config/missionId/${MISSION_ID}`,
    hdr
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. DocDelivery enregistré pour le dossier actif
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(65));
  console.log(`  2. GET docdelivery/search/applicationid?applicationId=${APPLICATION_ID}`);
  console.log("     → Choix de retrait enregistré pour CE dossier");
  console.log("─".repeat(65));
  await probe(
    "docdelivery/search/applicationid",
    `${BASE}/visadataexchangeapi/docdelivery/search/applicationid?applicationId=${APPLICATION_ID}`,
    hdr
  );

  // Essayer aussi avec le chemin alternatif (dataExchangeURL peut varier)
  await probe(
    "docdelivery/search/applicationid (alt path)",
    `${BASE}/dataexchange/docdelivery/search/applicationid?applicationId=${APPLICATION_ID}`,
    hdr
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. DocDelivery par applicantId (GSS)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(65));
  console.log(`  3. GET docdelivery/search/applicantId?applicantId=${APPLICANT_ID_GSS}`);
  console.log("     → Choix de retrait par applicantId GSS");
  console.log("─".repeat(65));
  await probe(
    "docdelivery/search/applicantId (GSS)",
    `${BASE}/visadataexchangeapi/docdelivery/search/applicantId?applicantId=${APPLICANT_ID_GSS}`,
    hdr
  );

  await probe(
    "docdelivery/search/applicantId (alt)",
    `${BASE}/dataexchange/docdelivery/search/applicantId?applicantId=${APPLICANT_ID_GSS}`,
    hdr
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. StepInfo DOCUMENT_DELIVERY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(65));
  console.log(`  4. GET stepdata/stepinfo/${APPLICATION_ID}/DOCUMENT_DELIVERY`);
  console.log("     → Metadata de l'étape delivery dans le workflow");
  console.log("─".repeat(65));
  await probe(
    "stepdata/stepinfo/DOCUMENT_DELIVERY",
    `${BASE}/visaworkflowprocessor/stepdata/stepinfo/${APPLICATION_ID}/DOCUMENT_DELIVERY`,
    hdr
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Essayer aussi les anciens dossiers
  // ═══════════════════════════════════════════════════════════════════════════
  const otherApps = ["be9d-cbc6-e401-0c9a", "6db2-93ca-ca87-43e8", "ed73-e013-d69d-cdc6"];
  console.log("\n" + "─".repeat(65));
  console.log("  5. Probe docdelivery sur les anciens dossiers");
  console.log("─".repeat(65));
  for (const appId of otherApps) {
    await probe(
      `docdelivery/search/applicationid (${appId})`,
      `${BASE}/visadataexchangeapi/docdelivery/search/applicationid?applicationId=${appId}`,
      hdr
    );
    await new Promise(r => setTimeout(r, 300));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. getMissionConfigurations (config globale mission)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(65));
  console.log("  6. GET custom/getbymissionid/323");
  console.log("     → Configuration globale de la mission (delivery activé?)");
  console.log("─".repeat(65));
  await probe(
    "custom/getbymissionid/323",
    `${BASE}/visaadministrationapi/v1/custom/getbymissionid/${MISSION_ID}`,
    hdr
  );

  setUsaSessionProxy(undefined);
  console.log("\n" + "═".repeat(65));
  console.log("  FIN — Données extraites ci-dessus");
  console.log("═".repeat(65));
}

main().catch(err => { console.error(err); process.exit(1); });
