import { _setTestFetch } from "./src/spain-soax-solver.js";
import { _setTestSessionProvider, scanSpainHttp } from "./src/spain-http-scanner.js";

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/#services";
process.env.SPAIN_WIDGET_URL = PORTAL_URL;

const PAD = `<!-- ${"x".repeat(1200)} -->`;
const LANDMARKS = `<div id="idBktWidgetDefaultBodyContainer"><div id="idDivBktServicesContainer">`;
const CLOSE = `</div></div>`;
const HTML = [
  `<html><body>`,
  LANDMARKS,
  `  <div style='display: none; text-align: center;'>No hay horas disponibles</div>`,
  `  <a href='#selectservice/bkt3452974'>`,
  `    <div class="clsBktServiceDataContainer">`,
  `      <div class="clsBktServiceDataName">Tramitación de visas</div>`,
  `    </div>`,
  `  </a>`,
  CLOSE,
  `</body></html>`,
  PAD,
].join("\n");

const session = {
  cfClearance: "x",
  cfDomain: ".citaconsular.es",
  soaxProxyUrl: "",
  userAgent: "Mozilla/5.0",
  createdAt: Date.now(),
  expiresAt: Date.now() + 999999,
  allCookies: [{ name: "PHPSESSID", value: "test" }],
  extraHeaders: {},
  source: "playwright" as const,
  prefetchedMainHtml: HTML,
};

_setTestSessionProvider(async () => session);
_setTestFetch(async (url) => {
  console.log("FETCH:", url.slice(0, 140));
  if (url.includes("getagendas")) return new Response('cb({"Agendas":[{"id":"ag1"}]});', { status: 200 });
  if (url.includes("datetime")) {
    return new Response(
      'cb({"Slots":[{"date":"2026-09-04","times":[{"time":"10:00","freeslots":1}]}]});',
      { status: 200 },
    );
  }
  if (url.includes("getwidgetconfigurations")) {
    return new Response('cb({"WidgetConfiguration":{"captcha":0}});', { status: 200 });
  }
  if (url.includes("getservices")) {
    return new Response('cb([{"id":"bkt3452974","name":"Visa"}]);', { status: 200 });
  }
  return null;
});

const r = await scanSpainHttp(PORTAL_URL);
console.log("RESULT:", r.status, r.errorMessage ?? "", r.slotInfo ?? "");
