/**
 * spain-confirmation-pdf.ts — Génération PDF de confirmation RDV Espagne (HTTP-only)
 *
 * Reproduit le ticket Bookitit (TicketView / idTemTicketAppointment) en HTML
 * puis le convertit en PDF via Playwright (page headless → page.pdf()).
 *
 * Données extraites de la réponse `summary/` :
 *   - Event.locator (code de confirmation)
 *   - Event.service / Appointment.serviceList
 *   - Event.date / Appointment.date
 *   - Event.time / Appointment.time
 *   - Event.agenda_name / Appointment.agenda
 *   - Customer.name
 *
 * Le PDF est ensuite uploadé vers Convex Storage et attaché au dossier
 * (même flow que le bot USA avec attachConfirmationDoc).
 */

import { chromium } from "playwright";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SpainConfirmationData {
  /** Code localisateur (ex: "ABC123") */
  locator: string;
  /** Nom du demandeur */
  applicantName: string;
  /** Date du RDV (format affiché, ex: "15/07/2026") */
  date: string;
  /** Heure du RDV (ex: "10:30") */
  time: string;
  /** Nom du service (ex: "Visado de corta estancia") */
  serviceName: string;
  /** Nom de l'agenda/guichet */
  agendaName?: string;
  /** Nombre de personnes */
  people?: number;
  /** Document du client (passeport, etc.) */
  document?: string;
  /** Infos supplémentaires de l'ambassade */
  extraInfo?: string;
}

// ─── HTML Template ──────────────────────────────────────────────────────────

function buildConfirmationHtml(data: SpainConfirmationData): string {
  const now = new Date();
  const createdAt = `${now.toLocaleDateString("es-ES")} ${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Confirmación de Cita — ${data.locator}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px; color: #1a1a1a; }
    
    .header {
      background: linear-gradient(135deg, #c60b1e 0%, #ffc400 100%);
      border-radius: 12px;
      padding: 24px 32px;
      margin-bottom: 32px;
      text-align: center;
    }
    .header h1 { color: white; font-size: 22px; margin: 0 0 4px; }
    .header p { color: rgba(255,255,255,0.9); font-size: 13px; margin: 0; }
    
    .badge {
      display: inline-block;
      background: #16a34a;
      color: white;
      padding: 6px 16px;
      border-radius: 20px;
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 24px;
    }
    
    .section {
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 20px 24px;
      margin-bottom: 20px;
    }
    .section h2 {
      font-size: 14px;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    
    .field {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #f3f4f6;
    }
    .field:last-child { border-bottom: none; }
    .field .label { font-weight: 600; color: #374151; font-size: 14px; }
    .field .value { color: #111827; font-size: 14px; text-align: right; }
    
    .locator-box {
      background: #f0fdf4;
      border: 2px solid #16a34a;
      border-radius: 10px;
      padding: 16px 24px;
      text-align: center;
      margin-bottom: 24px;
    }
    .locator-box .label { font-size: 12px; color: #15803d; text-transform: uppercase; letter-spacing: 1px; }
    .locator-box .code { font-size: 28px; font-weight: 700; color: #15803d; letter-spacing: 3px; margin-top: 4px; }
    
    .footer {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
      color: #9ca3af;
      font-size: 11px;
    }
    .footer .brand { font-weight: 600; color: #6b7280; }
    
    .info-box {
      background: #fffbeb;
      border: 1px solid #fbbf24;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 12px;
      color: #92400e;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🇪🇸 Embajada de España en Kinshasa</h1>
    <p>Confirmación de Cita Consular</p>
  </div>

  <div style="text-align: center;">
    <span class="badge">✓ Cita Confirmada</span>
  </div>

  <div class="locator-box">
    <div class="label">Localizador</div>
    <div class="code">${escapeHtml(data.locator)}</div>
  </div>

  <div class="section">
    <h2>Datos del Solicitante</h2>
    <div class="field">
      <span class="label">Nombre</span>
      <span class="value">${escapeHtml(data.applicantName)}</span>
    </div>
    ${data.document ? `<div class="field">
      <span class="label">Documento</span>
      <span class="value">${escapeHtml(data.document)}</span>
    </div>` : ""}
  </div>

  <div class="section">
    <h2>Detalles de la Cita</h2>
    <div class="field">
      <span class="label">Fecha</span>
      <span class="value">${escapeHtml(data.date)}</span>
    </div>
    <div class="field">
      <span class="label">Hora</span>
      <span class="value">${escapeHtml(data.time)} horas</span>
    </div>
    <div class="field">
      <span class="label">Servicio</span>
      <span class="value">${escapeHtml(data.serviceName)}</span>
    </div>
    ${data.agendaName ? `<div class="field">
      <span class="label">Agenda</span>
      <span class="value">${escapeHtml(data.agendaName)}</span>
    </div>` : ""}
    ${data.people && data.people > 1 ? `<div class="field">
      <span class="label">Personas</span>
      <span class="value">${data.people}</span>
    </div>` : ""}
  </div>

  ${data.extraInfo ? `<div class="info-box">
    <strong>Información importante:</strong><br/>
    ${escapeHtml(data.extraInfo)}
  </div>` : ""}

  <div class="info-box">
    <strong>Instrucciones:</strong><br/>
    Presentarse con este documento impreso el día de la cita en la Embajada de España (Avenue des Trois Z, Kinshasa-Gombe).
    Llevar pasaporte original y todos los documentos requeridos para el trámite solicitado.
  </div>

  <div class="footer">
    <p>Cita creada el ${escapeHtml(createdAt)}</p>
    <p class="brand">Joventy — Gestión de visas</p>
    <p style="margin-top: 4px;">citaconsular.es • Bookitit</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── PDF Generation ─────────────────────────────────────────────────────────

/**
 * Génère un PDF de confirmation de RDV Espagne.
 * Utilise Playwright headless (Chromium) pour le rendu HTML → PDF.
 *
 * @returns Buffer contenant le PDF, ou null en cas d'erreur
 */
export async function generateSpainConfirmationPdf(
  data: SpainConfirmationData,
): Promise<Buffer | null> {
  const t0 = Date.now();
  console.log(`[spain-pdf] 📄 Génération PDF confirmation — locator: ${data.locator}, demandeur: ${data.applicantName}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    const html = buildConfirmationHtml(data);

    await page.setContent(html, { waitUntil: "domcontentloaded" });

    const pdfBuffer = Buffer.from(
      await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      }),
    );

    await page.close();

    const elapsed = Date.now() - t0;
    console.log(`[spain-pdf] ✅ PDF généré: ${pdfBuffer.length} bytes (${elapsed}ms)`);
    return pdfBuffer;
  } catch (err) {
    console.error(`[spain-pdf] ❌ Erreur génération PDF: ${err}`);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ─── Helper: extraire les données de confirmation depuis summary/ ────────────

/**
 * Extrait les données de confirmation depuis la réponse du endpoint summary/.
 * La réponse peut avoir plusieurs formats :
 *   - [{Event: {locator, service, date, time, agenda_name, people}}]
 *   - {Event: {locator, ...}}
 *   - {Appointment: {locator, date, time, agenda, serviceList}}
 */
export function extractConfirmationData(
  summaryPayload: unknown,
  config: { applicantName: string; serviceName: string; slotDate: string; slotTime: string },
): SpainConfirmationData | null {
  if (!summaryPayload || typeof summaryPayload !== "object") return null;

  let locator = "";
  let agendaName = "";
  let people = 1;
  let date = config.slotDate;
  let time = config.slotTime;
  let serviceName = config.serviceName;

  const obj = summaryPayload as any;

  // Format 1: Array [{Event: {...}}]
  if (Array.isArray(obj)) {
    const first = obj[0];
    if (first?.Event) {
      locator = first.Event.locator ?? "";
      agendaName = first.Event.agenda_name ?? first.Event.agenda ?? "";
      serviceName = first.Event.service ?? serviceName;
      date = first.Event.date ?? date;
      time = first.Event.time ?? time;
      people = first.Event.people ?? 1;
    }
  }
  // Format 2: {Event: {...}}
  else if (obj.Event) {
    locator = obj.Event.locator ?? "";
    agendaName = obj.Event.agenda_name ?? obj.Event.agenda ?? "";
    serviceName = obj.Event.service ?? serviceName;
    date = obj.Event.date ?? date;
    time = obj.Event.time ?? time;
    people = obj.Event.people ?? 1;
  }
  // Format 3: {Appointment: {...}}
  else if (obj.Appointment) {
    locator = obj.Appointment.locator ?? "";
    agendaName = obj.Appointment.agenda ?? "";
    serviceName = obj.Appointment.serviceList ?? serviceName;
    date = obj.Appointment.date ?? date;
    time = obj.Appointment.time ?? time;
    people = obj.Appointment.people ?? 1;
  }

  if (!locator) return null;

  return {
    locator,
    applicantName: config.applicantName,
    date,
    time,
    serviceName,
    agendaName: agendaName || undefined,
    people: people > 1 ? people : undefined,
  };
}
