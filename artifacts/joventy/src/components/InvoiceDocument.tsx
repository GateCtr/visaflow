import { useRef, useState } from "react";
import { Download, Printer, CheckCircle2, Clock, XCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import { VISA_PRICING, SERVICE_PACKAGES, SLOT_URGENCY_TIERS } from "@convex/constants";

interface PriceDetails {
  engagementFee: number;
  successFee: number;
  paidAmount: number;
  isEngagementPaid: boolean;
  isSuccessFeePaid: boolean;
}

interface InvoiceApp {
  _id: string;
  _creationTime: number;
  applicantName: string;
  userEmail?: string;
  userPhone?: string;
  destination: string;
  visaType: string;
  status: string;
  price?: number;
  isPaid: boolean;
  priceDetails?: PriceDetails;
  servicePackage?: string;
  slotUrgencyTier?: string;
  successModel?: string;
  appointmentDetails?: { date: string; confirmationCode?: string };
}

interface InvoiceDocumentProps {
  app: InvoiceApp;
  type?: "facture" | "recu";
}

function StatusBadge({ paid }: { paid: boolean }) {
  if (paid) {
    return (
      <span style={{ display: "inline-block", height: "24px", lineHeight: "24px", padding: "0 12px", borderRadius: "12px", fontSize: "11px", fontWeight: 700, background: "#d1fae5", color: "#065f46", border: "1px solid #a7f3d0", whiteSpace: "nowrap", textAlign: "center" }}>
        ✓ PAYÉ
      </span>
    );
  }
  return (
    <span style={{ display: "inline-block", height: "24px", lineHeight: "24px", padding: "0 12px", borderRadius: "12px", fontSize: "11px", fontWeight: 700, background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a", whiteSpace: "nowrap", textAlign: "center" }}>
      ⏳ EN ATTENTE
    </span>
  );
}

function StatusGlobal({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <div style={{ padding: "12px 16px", borderRadius: "12px", background: "#ecfdf5", border: "1px solid #a7f3d0" }}>
        <table cellPadding="0" cellSpacing="0" style={{ width: "100%" }}>
          <tr>
            <td style={{ width: "24px", verticalAlign: "middle" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </td>
            <td style={{ verticalAlign: "middle", paddingLeft: "8px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#047857", lineHeight: "1.4" }}>DOSSIER CLÔTURÉ — PAYÉ INTÉGRALEMENT</span>
            </td>
          </tr>
        </table>
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div style={{ padding: "12px 16px", borderRadius: "12px", background: "#fef2f2", border: "1px solid #fecaca" }}>
        <table cellPadding="0" cellSpacing="0" style={{ width: "100%" }}>
          <tr>
            <td style={{ width: "24px", verticalAlign: "middle" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </td>
            <td style={{ verticalAlign: "middle", paddingLeft: "8px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#b91c1c", lineHeight: "1.4" }}>DOSSIER REJETÉ</span>
            </td>
          </tr>
        </table>
      </div>
    );
  }
  return (
    <div style={{ padding: "12px 16px", borderRadius: "12px", background: "#fffbeb", border: "1px solid #fde68a" }}>
      <table cellPadding="0" cellSpacing="0" style={{ width: "100%" }}>
        <tr>
          <td style={{ width: "24px", verticalAlign: "middle" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </td>
          <td style={{ verticalAlign: "middle", paddingLeft: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#b45309", lineHeight: "1.4" }}>PAIEMENT PARTIEL — SOLDE EN ATTENTE</span>
          </td>
        </tr>
      </table>
    </div>
  );
}

import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

/* ─── Pré-convertit les images externes en data URL pour éviter le blocage html2canvas ─── */
async function preloadImages(el: HTMLElement): Promise<Map<HTMLImageElement, string>> {
  const imgs = Array.from(el.querySelectorAll("img")) as HTMLImageElement[];
  const restored = new Map<HTMLImageElement, string>();

  await Promise.allSettled(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src || src.startsWith("data:")) return;
      restored.set(img, src);
      try {
        const resp = await Promise.race<Response>([
          fetch(src, { mode: "cors", cache: "force-cache" }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), 4000)
          ),
        ]);
        const blob = await resp.blob();
        const dataUrl = await new Promise<string>((res) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result as string);
          reader.readAsDataURL(blob);
        });
        img.src = dataUrl;
      } catch {
        img.style.visibility = "hidden";
      }
    })
  );

  return restored;
}

function restoreImages(restored: Map<HTMLImageElement, string>) {
  restored.forEach((src, img) => {
    img.src = src;
    img.style.visibility = "";
  });
}

/**
 * html2canvas ne supporte pas oklch() (CSS Color Level 4, utilisé par Tailwind v4 / shadcn).
 * On utilise une conversion pure JS pour convertir chaque occurrence oklch → rgb.
 */
const oklchCache = new Map<string, string>();

/**
 * Convertit oklch en rgb directement (sans dépendre du navigateur)
 * Basé sur la spécification CSS Color Level 4
 */
function oklchToRgb(oklch: string): string {
  // Parser oklch(l c h / alpha)
  const match = oklch.match(/oklch\s*\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*([\d.]+%?))?\s*\)/i);
  if (!match) return "rgb(0,0,0)";

  let l = parseFloat(match[1]);
  let c = parseFloat(match[2]);
  let h = parseFloat(match[3]);
  const alpha = match[4] ? parseFloat(match[4]) : 1;

  // Convertir les pourcentages en valeurs décimales
  if (match[1].includes("%")) l /= 100;
  if (match[2].includes("%")) c /= 100;
  if (match[3].includes("%")) h /= 100;

  // Convertir oklch en oklab
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  // Convertir oklab en XYZ (D65)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const l__ = l_ * l_ * l_;
  const m__ = m_ * m_ * m_;
  const s__ = s_ * s_ * s_;

  const x = +4.0767416621 * l__ - 3.3077335964 * m__ + 0.2309699292 * s__;
  const y = -1.2684380046 * l__ + 2.6097574011 * m__ - 0.3413193965 * s__;
  const z = -0.0041960863 * l__ - 0.7034186147 * m__ + 1.7076147010 * s__;

  // Convertir XYZ en sRGB (D65)
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  const b_ = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

  // Gamma correction sRGB
  const toLinear = (v: number) => v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  const toGamma = (v: number) => v > 0.0031308 ? 1.055 * Math.pow(v, 1 / 2.4) - 0.055 : 12.92 * v;

  const rLinear = toLinear(r);
  const gLinear = toLinear(g);
  const bLinear = toLinear(b_);

  const rGamma = toGamma(rLinear);
  const gGamma = toGamma(gLinear);
  const bGamma = toGamma(bLinear);

  // Clip et convertir en 0-255
  const r255 = Math.max(0, Math.min(255, Math.round(rGamma * 255)));
  const g255 = Math.max(0, Math.min(255, Math.round(gGamma * 255)));
  const b255 = Math.max(0, Math.min(255, Math.round(bGamma * 255)));

  if (alpha < 1) {
    return `rgba(${r255}, ${g255}, ${b255}, ${alpha})`;
  }
  return `rgb(${r255}, ${g255}, ${b255})`;
}

function convertOklchValue(oklchStr: string): string {
  const oklchRe = /oklch\([^)]*\)/g;
  let result = oklchStr.replace(oklchRe, (m) => {
    const trimmed = m.trim();
    if (oklchCache.has(trimmed)) {
      return oklchCache.get(trimmed)!;
    }
    try {
      const rgb = oklchToRgb(trimmed);
      oklchCache.set(trimmed, rgb);
      return rgb;
    } catch {
      return "rgb(0,0,0)";
    }
  });
  
  // Aussi convertir oklab en rgb
  const oklabRe = /oklab\([^)]*\)/g;
  result = result.replace(oklabRe, (m) => {
    const trimmed = m.trim();
    if (oklchCache.has(trimmed)) {
      return oklchCache.get(trimmed)!;
    }
    try {
      const rgb = oklabToRgb(trimmed);
      oklchCache.set(trimmed, rgb);
      return rgb;
    } catch {
      return "rgb(0,0,0)";
    }
  });
  
  return result;
}

/**
 * Convertit oklab en rgb directement (sans dépendre du navigateur)
 * Basé sur la spécification CSS Color Level 4
 */
function oklabToRgb(oklab: string): string {
  // Parser oklab(l a b / alpha)
  const match = oklab.match(/oklab\s*\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*([\d.]+%?))?\s*\)/i);
  if (!match) return "rgb(0,0,0)";

  let l = parseFloat(match[1]);
  let a = parseFloat(match[2]);
  let b = parseFloat(match[3]);
  const alpha = match[4] ? parseFloat(match[4]) : 1;

  // Convertir les pourcentages en valeurs décimales
  if (match[1].includes("%")) l /= 100;
  if (match[2].includes("%")) a /= 100;
  if (match[3].includes("%")) b /= 100;

  // Convertir oklab en XYZ (D65)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const l__ = l_ * l_ * l_;
  const m__ = m_ * m_ * m_;
  const s__ = s_ * s_ * s_;

  const x = +4.0767416621 * l__ - 3.3077335964 * m__ + 0.2309699292 * s__;
  const y = -1.2684380046 * l__ + 2.6097574011 * m__ - 0.3413193965 * s__;
  const z = -0.0041960863 * l__ - 0.7034186147 * m__ + 1.7076147010 * s__;

  // Convertir XYZ en sRGB (D65)
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  const b_ = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

  // Gamma correction sRGB
  const toLinear = (v: number) => v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  const toGamma = (v: number) => v > 0.0031308 ? 1.055 * Math.pow(v, 1 / 2.4) - 0.055 : 12.92 * v;

  const rLinear = toLinear(r);
  const gLinear = toLinear(g);
  const bLinear = toLinear(b_);

  const rGamma = toGamma(rLinear);
  const gGamma = toGamma(gLinear);
  const bGamma = toGamma(bLinear);

  // Clip et convertir en 0-255
  const r255 = Math.max(0, Math.min(255, Math.round(rGamma * 255)));
  const g255 = Math.max(0, Math.min(255, Math.round(gGamma * 255)));
  const b255 = Math.max(0, Math.min(255, Math.round(bGamma * 255)));

  if (alpha < 1) {
    return `rgba(${r255}, ${g255}, ${b255}, ${alpha})`;
  }
  return `rgb(${r255}, ${g255}, ${b255})`;
}

/**
 * Pré-traite toutes les règles CSS pour convertir oklch/oklab → rgb.
 * html2canvas lit parfois les CSS directement sans passer par getComputedStyle.
 */
function patchAllCssRules(): void {
  try {
    const sheets = Array.from(document.styleSheets);
    for (const sheet of sheets) {
      try {
        const rules = Array.from(sheet.cssRules);
        for (const rule of rules) {
          // Seuls CSSStyleRule ont une propriété style
          if ((rule as CSSStyleRule).style) {
            const styleRule = rule as CSSStyleRule;
            for (let i = 0; i < styleRule.style.length; i++) {
              const prop = styleRule.style[i];
              const val = styleRule.style.getPropertyValue(prop);
              if (val && (val.includes("oklch") || val.includes("oklab"))) {
                const converted = convertOklchValue(val);
                styleRule.style.setProperty(prop, converted);
              }
            }
          }
        }
      } catch (e) {
        // Ignore CORS errors on stylesheets
      }
    }
  } catch (e) {
    // Ignore errors accessing stylesheets
  }
}

/* ─── Génère le PDF en capturant uniquement le div document ─── */
async function generatePdf(el: HTMLElement, filename: string) {
  const restored = await preloadImages(el);

  let canvas: HTMLCanvasElement;
  const originalGetComputedStyle = window.getComputedStyle;

  // Pré-traite toutes les règles CSS pour convertir oklch/oklab → rgb
  patchAllCssRules();

  // Proxy getComputedStyle pour intercepter et patcher les couleurs oklch/oklab retournées à html2canvas
  window.getComputedStyle = (elt, pseudoElt) => {
    const style = originalGetComputedStyle(elt, pseudoElt);
    return new Proxy(style, {
      get(target, prop) {
        if (prop === "getPropertyValue") {
          return (propertyName: string) => {
            const val = target.getPropertyValue(propertyName);
            if (val && (val.includes("oklch") || val.includes("oklab"))) {
              return convertOklchValue(val);
            }
            return val;
          };
        }
        const val = (target as any)[prop];
        if (typeof val === "string" && (val.includes("oklch") || val.includes("oklab"))) {
          return convertOklchValue(val);
        }
        if (typeof val === "function") {
          return val.bind(target);
        }
        return val;
      }
    });
  };

  try {
    canvas = await html2canvas(el, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: "#ffffff",
      logging: false,
      imageTimeout: 0,
    });
  } finally {
    window.getComputedStyle = originalGetComputedStyle;
    restoreImages(restored);
  }

  const imgData = canvas!.toDataURL("image/png");
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgH = (canvas!.height * pageW) / canvas!.width;

  let heightLeft = imgH;
  let position = 0;
  pdf.addImage(imgData, "PNG", 0, position, pageW, imgH);
  heightLeft -= pageH;
  while (heightLeft > 0) {
    position = heightLeft - imgH;
    pdf.addPage();
    pdf.addImage(imgData, "PNG", 0, position, pageW, imgH);
    heightLeft -= pageH;
  }

  const blob = pdf.output("blob");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/* ─── Imprime uniquement le div document dans une nouvelle fenêtre ─── */
function printElement(el: HTMLElement, title: string) {
  // Récupère toutes les règles CSS compilées de la page courante
  const cssTexts = Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try { return Array.from(sheet.cssRules).map((r) => r.cssText); }
      catch { return []; }
    })
    .join("\n");

  const win = window.open("", "_blank", "width=960,height=700");
  if (!win) return;

  win.document.write(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
  <style>${cssTexts}</style>
  <style>
    @page { margin: 10mm; }
    body { background: white; margin: 0; padding: 0; font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif; }
  </style>
</head>
<body>${el.outerHTML}</body>
</html>`);
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); win.close(); }, 800);
}

export function InvoiceDocument({ app, type = "facture" }: InvoiceDocumentProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const pricing = VISA_PRICING[app.destination as keyof typeof VISA_PRICING];
  const successModel = app.successModel ?? pricing?.successModel ?? "appointment";
  const servicePackage = app.servicePackage ?? "full_service";
  const isDossierOnly = servicePackage === "dossier_only";
  const packageLabel = SERVICE_PACKAGES?.[servicePackage as keyof typeof SERVICE_PACKAGES]?.label ?? servicePackage;
  const urgencyLabel = app.slotUrgencyTier
    ? SLOT_URGENCY_TIERS[app.slotUrgencyTier as keyof typeof SLOT_URGENCY_TIERS]?.label
    : null;

  const engagementFee = app.priceDetails?.engagementFee ?? 0;
  const successFee = app.priceDetails?.successFee ?? 0;
  const paidAmount = app.priceDetails?.paidAmount ?? 0;
  const isEngagementPaid = app.priceDetails?.isEngagementPaid ?? false;
  const isSuccessFeePaid = app.priceDetails?.isSuccessFeePaid ?? false;
  const total = engagementFee + (isDossierOnly ? 0 : successFee);
  const balanceDue = Math.max(0, total - paidAmount);

  const createdDate = new Date(app._creationTime).toLocaleDateString("fr-FR", {
    day: "numeric", month: "long", year: "numeric",
  });

  const invoiceNumber = `JVT-${new Date(app._creationTime).getFullYear()}${String(new Date(app._creationTime).getMonth() + 1).padStart(2, "0")}-${app._id.slice(-6).toUpperCase()}`;
  const destInfo = VISA_PRICING[app.destination as keyof typeof VISA_PRICING];

  const handleDownload = async () => {
    if (!printRef.current) return;
    setIsGenerating(true);
    try {
      await generatePdf(printRef.current, `${invoiceNumber}.pdf`);
    } catch (err) {
      console.error("PDF generation error:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePrint = () => {
    if (!printRef.current) return;
    printElement(printRef.current, invoiceNumber);
  };

  return (
    <div className="space-y-4">
      {/* ── Barre d'actions (cachée à l'impression) ── */}
      <div className="flex items-center justify-between flex-wrap gap-3 print:hidden">
        <div>
          <h2 className="text-base font-bold text-slate-800">
            {type === "recu" ? "Reçu de paiement" : "Facture"}
          </h2>
          <p className="text-xs text-slate-500">{invoiceNumber}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handlePrint} className="gap-1.5 text-xs">
            <Printer className="w-3.5 h-3.5" />
            Imprimer
          </Button>
          <Button
            size="sm"
            onClick={handleDownload}
            disabled={isGenerating}
            className="gap-1.5 text-xs bg-[#0B111E] hover:bg-[#1a2540] text-white"
          >
            <Download className="w-3.5 h-3.5" />
            {isGenerating ? "Génération…" : "Télécharger PDF"}
          </Button>
        </div>
      </div>

      {/* ── Document facture / reçu ── */}
      <div
        ref={printRef}
        className="bg-white rounded-2xl overflow-hidden shadow-lg border border-slate-200"
        style={{ fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif" }}
      >
        {/* ── EN-TÊTE ── */}
        <div style={{ background: "#0B111E" }} className="px-4 sm:px-8 py-5 sm:py-7">
          {/* Ligne 1 : logo + badge facture */}
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <img
                src="https://akollad.com/web-app-manifest-512x512.png"
                alt="Akollad"
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl flex-shrink-0"
                crossOrigin="anonymous"
              />
              <div>
                <div className="text-white font-bold text-base sm:text-lg tracking-tight leading-none">
                  Akollad Groupe
                </div>
                <div className="text-slate-400 text-xs mt-0.5 hidden sm:block">
                  Holding Technologique Africaine
                </div>
                <div className="text-slate-400 text-xs">
                  Kinshasa, République Démocratique du Congo
                </div>
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <div
                style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", padding: "6px 12px", borderRadius: "8px", marginBottom: "8px", display: "inline-block", background: "#F59E0B", color: "#0B111E", lineHeight: "1.2" }}
              >
                {type === "recu" ? "REÇU" : "FACTURE"}
              </div>
              <div className="text-white font-mono text-sm font-bold block">{invoiceNumber}</div>
              <div className="text-slate-400 text-xs mt-1">Émis le {createdDate}</div>
            </div>
          </div>

          {/* Ligne 2 : service + identifiants légaux */}
          <div className="mt-4 sm:mt-6 pt-4 border-t border-white/10">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "#F59E0B" }} />
                  <span className="text-white text-sm font-semibold">
                    Joventy — Service d'Accompagnement Visa
                  </span>
                </div>
                <div className="text-slate-400 text-xs mt-0.5 ml-3.5">
                  contact@akollad.com · joventy.cd · WhatsApp : +243 840 808 122
                </div>
              </div>
              <div className="text-slate-400 text-[10px] leading-relaxed space-y-0.5 sm:text-right flex-shrink-0">
                <div><span className="text-slate-500 font-semibold">RCCM :</span> CD/KNG/RCCM/25-A-07960</div>
                <div><span className="text-slate-500 font-semibold">N° Impôt :</span> A2557944L</div>
                <div><span className="text-slate-500 font-semibold">IDNAT :</span> 01-J6100-N86614P</div>
              </div>
            </div>
          </div>
        </div>

        {/* ── CORPS ── */}
        <div className="px-4 sm:px-8 py-4 sm:py-6 space-y-5 sm:space-y-6">

          {/* CLIENT + DOSSIER INFO */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            <div>
              <div className="text-[10px] font-bold tracking-widest text-slate-400 uppercase mb-2">
                Facturé à
              </div>
              <div className="text-slate-900 font-bold text-base">{app.applicantName}</div>
              {app.userEmail && <div className="text-slate-500 text-xs mt-0.5">{app.userEmail}</div>}
              {app.userPhone && <div className="text-slate-500 text-xs">{app.userPhone}</div>}
            </div>
            <div>
              <div className="text-[10px] font-bold tracking-widest text-slate-400 uppercase mb-2">
                Détails du dossier
              </div>
              <div className="space-y-1">
                {[
                  ["Destination", `${destInfo?.flag ?? ""} ${destInfo?.label ?? app.destination}`],
                  ["Type de visa", app.visaType],
                  ["Package", packageLabel],
                  urgencyLabel ? ["Urgence", urgencyLabel] : null,
                  successModel === "evisa" ? ["Mode", "E-Visa / Sans rendez-vous"] : null,
                ].filter((r): r is [string, string] => r !== null).map(([label, value]) => (
                  <div key={label as string} className="flex items-start gap-2">
                    <span className="text-xs text-slate-400 w-20 flex-shrink-0">{label}</span>
                    <span className={`text-xs font-semibold ${label === "Mode" ? "text-amber-700" : "text-slate-800"}`}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* TABLEAU DES LIGNES — scrollable sur mobile */}
          <div className="overflow-x-auto rounded-xl">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr style={{ background: "#0B111E" }}>
                  <th className="text-left text-white text-xs font-semibold px-3 sm:px-4 py-3 rounded-tl-xl">Prestation</th>
                  <th className="text-left text-white text-xs font-semibold px-3 sm:px-4 py-3">Description</th>
                  <th className="text-right text-white text-xs font-semibold px-3 sm:px-4 py-3">Montant</th>
                  <th className="text-center text-white text-xs font-semibold px-3 sm:px-4 py-3 rounded-tr-xl">Statut</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-100">
                  <td className="px-3 sm:px-4 py-3 text-slate-800 font-semibold text-sm">
                    Frais d'engagement
                  </td>
                  <td className="px-3 sm:px-4 py-3 text-slate-500 text-xs">
                    Ouverture et traitement du dossier · Mise en surveillance portail consulaire
                  </td>
                  <td className="px-3 sm:px-4 py-3 text-right font-bold text-slate-900 whitespace-nowrap">
                    {formatCurrency(engagementFee)}
                  </td>
                  <td className="px-3 sm:px-4 py-3 text-center">
                    <StatusBadge paid={isEngagementPaid} />
                  </td>
                </tr>
                {!isDossierOnly && (
                  <tr className="border-b border-slate-100">
                    <td className="px-3 sm:px-4 py-3 text-slate-800 font-semibold text-sm">
                      Prime de succès
                    </td>
                    <td className="px-3 sm:px-4 py-3 text-slate-500 text-xs">
                      {successModel === "evisa"
                        ? "Due uniquement si le visa est accordé par l'autorité compétente"
                        : "Due uniquement après obtention effective d'un créneau consulaire"}
                    </td>
                    <td className="px-3 sm:px-4 py-3 text-right font-bold text-slate-900 whitespace-nowrap">
                      {formatCurrency(successFee)}
                    </td>
                    <td className="px-3 sm:px-4 py-3 text-center">
                      <StatusBadge paid={isSuccessFeePaid} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* TOTAUX */}
          <div className="flex justify-end">
            <div className="w-full sm:w-64 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Sous-total</span>
                <span className="font-semibold text-slate-800">{formatCurrency(total)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Montant payé</span>
                <span className="font-semibold text-emerald-700">−{formatCurrency(paidAmount)}</span>
              </div>
              <div className="flex justify-between text-sm font-bold pt-2 border-t-2 border-slate-900">
                <span className="text-slate-900">Solde dû</span>
                <span className={balanceDue > 0 ? "text-red-600 text-base" : "text-emerald-600 text-base"}>
                  {formatCurrency(balanceDue)}
                </span>
              </div>
            </div>
          </div>

          {/* STATUT GLOBAL */}
          <StatusGlobal status={app.status} />

          {/* RDV info */}
          {app.appointmentDetails?.date && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <div className="text-xs font-bold text-emerald-800 uppercase tracking-wide mb-1">
                Rendez-vous Consulaire Obtenu
              </div>
              <div className="text-sm font-semibold text-emerald-900">
                {app.appointmentDetails.date}
              </div>
              {app.appointmentDetails.confirmationCode && (
                <div className="text-xs text-emerald-700 mt-0.5 font-mono">
                  Réf : {app.appointmentDetails.confirmationCode}
                </div>
              )}
            </div>
          )}

          {/* MODALITÉS PAIEMENT */}
          <div className="rounded-xl px-4 py-3 text-xs" style={{ background: "#F8FAFC", border: "1px solid #E2E8F0" }}>
            <div className="font-bold text-slate-700 mb-1.5">Modalités de paiement</div>
            <div className="text-slate-500 space-y-0.5">
              <div>Paiements via <strong className="text-slate-700">Mobile Money</strong> (M-Pesa, Airtel Money, Orange Money)</div>
              <div>Les justificatifs de paiement sont archivés sur la plateforme Joventy</div>
            </div>
          </div>
        </div>

        {/* ── FOOTER ── */}
        <div style={{ background: "#F1F5F9", borderTop: "1px solid #E2E8F0" }} className="px-4 sm:px-8 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4">
            <div className="flex items-center gap-2">
              <img
                src="https://akollad.com/web-app-manifest-512x512.png"
                alt="Akollad"
                className="w-6 h-6 rounded flex-shrink-0"
                crossOrigin="anonymous"
              />
              <span className="text-xs text-slate-500">
                <strong className="text-slate-700">Akollad Groupe</strong> — Kinshasa, RDC · contact@akollad.com
              </span>
            </div>
            <div className="text-xs text-slate-400">
              Joventy est un produit d'Akollad Groupe · joventy.cd
            </div>
          </div>
          <div className="mt-2 text-[10px] text-slate-400 text-center leading-relaxed">
            Ce document a valeur de facture officielle. Signature numérique archivée sur la plateforme Joventy.
            Droit applicable : République Démocratique du Congo — Juridictions de Kinshasa.
          </div>
          <div className="mt-1 text-[10px] text-slate-400 text-center">
            RCCM : CD/KNG/RCCM/25-A-07960 &nbsp;·&nbsp; N° Impôt : A2557944L &nbsp;·&nbsp; IDNAT : 01-J6100-N86614P
          </div>
        </div>
      </div>
    </div>
  );
}
