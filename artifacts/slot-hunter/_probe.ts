import { scanSpainHttp } from "./src/spain-http-scanner.js";

const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
console.log(`[probe] Lancement probe Kinshasa → ${PORTAL_URL}`);
const t0 = Date.now();
const result = await scanSpainHttp(PORTAL_URL);
const r = result as any;
console.log(`[probe] Résultat (${Date.now()-t0}ms):`, JSON.stringify({
  status: result.status,
  slotInfo: r.slotInfo,
  errorMessage: r.errorMessage?.slice(0, 300),
  scanDurationMs: r.scanDurationMs,
}, null, 2));
