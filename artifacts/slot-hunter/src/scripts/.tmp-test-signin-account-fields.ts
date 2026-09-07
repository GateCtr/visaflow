import "dotenv/config";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { initWorkerSession } from "../spain-soax-solver.js";
import { getResidentialProxyUrl } from "../spain-portals.js";
import { buildDynamicSession, callDirect } from "../spain-bookitit-direct.js";
import { SAOPOLO_PORTAL_URL, CUBA_LMD_PORTAL_URL } from "../spain-portals.js";

function addStickySession(proxyUrl: string, sid: string): string {
  const u = new URL(proxyUrl);
  const user = decodeURIComponent(u.username);
  const sticky = user.includes("-session-")
    ? user.replace(/-session-[^-:@]+/, `-session-${sid}`)
    : user.replace(/(-sessionduration-[^-:@]+)?$/, `-session-${sid}$1`);
  u.username = encodeURIComponent(sticky);
  return u.toString();
}

function safeFields(payload: any): Array<Record<string, unknown>> {
  const clients = payload?.CustomFields?.Clients ?? payload?.Clients ?? [];
  if (!Array.isArray(clients)) return [];
  return clients
    .filter((field: any) => field && typeof field === "object")
    .map((field: any) => ({
      input_text: field.input_text,
      field_text: field.field_text,
      show_widget: field.show_widget,
      validate: field.validate,
    }));
}

async function testPortal(label: string, portalUrl: string): Promise<void> {
  const proxyBase = getResidentialProxyUrl(0);
  if (!proxyBase) throw new Error("SPAIN_RESIDENTIAL_PROXY_URL missing");
  const proxy = addStickySession(proxyBase, `fields${label.toLowerCase()}${Date.now().toString(36).slice(-6)}`);
  const apiKey = process.env.CAPSOLVER_API_KEY ?? "";
  const init = await initWorkerSession(proxy, portalUrl.split("#")[0], apiKey);
  if (!init) {
    console.log(JSON.stringify({ portal: label, status: "session_init_failed" }));
    return;
  }
  const ds = buildDynamicSession(init.session);
  if (!ds) {
    console.log(JSON.stringify({ portal: label, status: "dynamic_session_failed" }));
    return;
  }
  const payload = await callDirect(ds, "getsigninaccountfields/", undefined, `[fields:${label}]`);
  console.log(JSON.stringify({ portal: label, status: "ok", fields: safeFields(payload) }));
}

await initSpainRedis().catch(() => {});
await testPortal("SAOPOLO", SAOPOLO_PORTAL_URL);
await testPortal("CUBA", CUBA_LMD_PORTAL_URL);
