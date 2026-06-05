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
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700, background: "#d1fae5", color: "#065f46", border: "1px solid #a7f3d0" }}>
        ✓ PAYÉ
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700, background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
      ⏳ EN ATTENTE
    </span>
  );
}

function StatusGlobal({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200">
        <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
        <span className="text-sm font-bold text-emerald-700">DOSSIER CLÔTURÉ — PAYÉ INTÉGRALEMENT</span>
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 border border-red-200">
        <XCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
        <span className="text-sm font-bold text-red-700">DOSSIER REJETÉ</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200">
      <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
      <span className="text-sm font-bold text-amber-700">PAIEMENT PARTIEL — SOLDE EN ATTENTE</span>
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
 * On utilise le moteur de rendu du navigateur pour convertir chaque occurrence oklch → rgb.
 */
const oklchCache = new Map<string, string>();

function convertOklchValue(oklchStr: string, originalGetComputedStyle: typeof window.getComputedStyle): string {
  const oklchRe = /oklch\([^)]*\)/g;
  return oklchStr.replace(oklchRe, (m) => {
    const trimmed = m.trim();
    if (oklchCache.has(trimmed)) {
      return oklchCache.get(trimmed)!;
    }
    try {
      const tmp = document.createElement("div");
      tmp.style.color = trimmed;
      document.documentElement.appendChild(tmp);
      const rgb = originalGetComputedStyle(tmp).color;
      document.documentElement.removeChild(tmp);
      const result = rgb && rgb !== "rgba(0, 0, 0, 0)" ? rgb : "rgb(0,0,0)";
      oklchCache.set(trimmed, result);
      return result;
    } catch {
      return "rgb(0,0,0)";
    }
  });
}

/* ─── Génère le PDF en capturant uniquement le div document ─── */
async function generatePdf(el: HTMLElement, filename: string) {
  const restored = await preloadImages(el);

  let canvas: HTMLCanvasElement;
  const originalGetComputedStyle = window.getComputedStyle;

  // Proxy getComputedStyle pour intercepter et patcher les couleurs oklch retournées à html2canvas
  window.getComputedStyle = (elt, pseudoElt) => {
    const style = originalGetComputedStyle(elt, pseudoElt);
    return new Proxy(style, {
      get(target, prop) {
        if (prop === "getPropertyValue") {
          return (propertyName: string) => {
            const val = target.getPropertyValue(propertyName);
            if (val && val.includes("oklch")) {
              return convertOklchValue(val, originalGetComputedStyle);
            }
            return val;
          };
        }
        const val = (target as any)[prop];
        if (typeof val === "string" && val.includes("oklch")) {
          return convertOklchValue(val, originalGetComputedStyle);
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
                className="text-xs font-bold tracking-widest uppercase px-3 py-1 rounded-lg mb-2 inline-block"
                style={{ background: "#F59E0B", color: "#0B111E" }}
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
