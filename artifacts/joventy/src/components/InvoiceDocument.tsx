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

function StatusBadge({ paid, label }: { paid: boolean; label?: string }) {
  if (paid) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="w-2.5 h-2.5" /> {label ?? "PAYÉ"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200">
      <Clock className="w-2.5 h-2.5" /> EN ATTENTE
    </span>
  );
}

function StatusGlobal({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-50 border border-emerald-200">
        <CheckCircle2 className="w-5 h-5 text-emerald-600" />
        <span className="text-sm font-bold text-emerald-700">DOSSIER CLÔTURÉ — PAYÉ INTÉGRALEMENT</span>
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-50 border border-red-200">
        <XCircle className="w-5 h-5 text-red-600" />
        <span className="text-sm font-bold text-red-700">DOSSIER REJETÉ</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-50 border border-amber-200">
      <AlertCircle className="w-5 h-5 text-amber-600" />
      <span className="text-sm font-bold text-amber-700">PAIEMENT PARTIEL — SOLDE EN ATTENTE</span>
    </div>
  );
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
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const invoiceNumber = `JVT-${new Date(app._creationTime).getFullYear()}${String(new Date(app._creationTime).getMonth() + 1).padStart(2, "0")}-${app._id.slice(-6).toUpperCase()}`;
  const destInfo = VISA_PRICING[app.destination as keyof typeof VISA_PRICING];

  const handleDownload = async () => {
    if (!printRef.current) return;
    setIsGenerating(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const { jsPDF } = await import("jspdf");

      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        logging: false,
      });

      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

      pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight);
      pdf.save(`${invoiceNumber}.pdf`);
    } catch (err) {
      console.error("PDF generation error:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="space-y-4">
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
          <Button size="sm" onClick={handleDownload} disabled={isGenerating} className="gap-1.5 text-xs bg-[#0B111E] hover:bg-[#1a2540] text-white">
            <Download className="w-3.5 h-3.5" />
            {isGenerating ? "Génération…" : "Télécharger PDF"}
          </Button>
        </div>
      </div>

      <div
        ref={printRef}
        className="bg-white rounded-2xl overflow-hidden shadow-lg border border-slate-200 print:shadow-none print:border-0"
        style={{ fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif" }}
      >
        {/* ── HEADER AKOLLAD ── */}
        <div style={{ background: "#0B111E" }} className="px-8 py-7">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              <img
                src="https://akollad.com/web-app-manifest-512x512.png"
                alt="Akollad"
                className="w-12 h-12 rounded-xl"
                crossOrigin="anonymous"
              />
              <div>
                <div className="text-white font-bold text-lg tracking-tight leading-none">
                  Akollad Groupe
                </div>
                <div className="text-slate-400 text-xs mt-0.5">
                  Holding Technologique Africaine
                </div>
                <div className="text-slate-400 text-xs">
                  Kinshasa, République Démocratique du Congo
                </div>
              </div>
            </div>
            <div className="text-right">
              <div
                className="text-xs font-bold tracking-widest uppercase px-3 py-1 rounded-lg mb-2"
                style={{ background: "#F59E0B", color: "#0B111E" }}
              >
                {type === "recu" ? "REÇU" : "FACTURE"}
              </div>
              <div className="text-white font-mono text-sm font-bold">{invoiceNumber}</div>
              <div className="text-slate-400 text-xs mt-1">Émis le {createdDate}</div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-white/10">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <div
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: "#F59E0B" }}
                  />
                  <span className="text-white text-sm font-semibold">
                    Joventy — Service d'Accompagnement Visa
                  </span>
                </div>
                <div className="text-slate-400 text-xs mt-0.5 ml-3.5">
                  contact@akollad.com · joventy.cd · WhatsApp : +243 840 808 122
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-slate-400 text-[10px] leading-relaxed space-y-0.5">
                  <div><span className="text-slate-500 font-semibold">RCCM :</span> CD/KNG/RCCM/25-A-07960</div>
                  <div><span className="text-slate-500 font-semibold">N° Impôt :</span> A2557944L</div>
                  <div><span className="text-slate-500 font-semibold">IDNAT :</span> 01-J6100-N86614P</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── CORPS FACTURE ── */}
        <div className="px-8 py-6 space-y-6">

          {/* CLIENT + DOSSIER INFO */}
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="text-[10px] font-bold tracking-widest text-slate-400 uppercase mb-2">
                Facturé à
              </div>
              <div className="text-slate-900 font-bold text-base">{app.applicantName}</div>
              {app.userEmail && (
                <div className="text-slate-500 text-xs mt-0.5">{app.userEmail}</div>
              )}
              {app.userPhone && (
                <div className="text-slate-500 text-xs">{app.userPhone}</div>
              )}
            </div>
            <div>
              <div className="text-[10px] font-bold tracking-widest text-slate-400 uppercase mb-2">
                Détails du dossier
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 w-20">Destination</span>
                  <span className="text-xs font-semibold text-slate-800">
                    {destInfo?.flag} {destInfo?.label ?? app.destination}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 w-20">Type de visa</span>
                  <span className="text-xs font-semibold text-slate-800">{app.visaType}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 w-20">Package</span>
                  <span className="text-xs font-semibold text-slate-800">{packageLabel}</span>
                </div>
                {urgencyLabel && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 w-20">Urgence</span>
                    <span className="text-xs font-semibold text-slate-800">{urgencyLabel}</span>
                  </div>
                )}
                {successModel === "evisa" && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 w-20">Mode</span>
                    <span className="text-xs font-semibold text-amber-700">E-Visa / Sans rendez-vous</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* TABLEAU DES LIGNES */}
          <div>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#0B111E" }}>
                  <th className="text-left text-white text-xs font-semibold px-4 py-3 rounded-tl-lg">
                    Prestation
                  </th>
                  <th className="text-left text-white text-xs font-semibold px-4 py-3">
                    Description
                  </th>
                  <th className="text-right text-white text-xs font-semibold px-4 py-3">
                    Montant
                  </th>
                  <th className="text-center text-white text-xs font-semibold px-4 py-3 rounded-tr-lg">
                    Statut
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* Frais d'engagement */}
                <tr className="border-b border-slate-100">
                  <td className="px-4 py-3 text-slate-800 font-semibold text-sm">
                    Frais d'engagement
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    Ouverture et traitement du dossier · Mise en surveillance portail consulaire
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-slate-900">
                    {formatCurrency(engagementFee)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge paid={isEngagementPaid} />
                  </td>
                </tr>

                {/* Prime de succès — seulement si pas dossier_only */}
                {!isDossierOnly && (
                  <tr className="border-b border-slate-100">
                    <td className="px-4 py-3 text-slate-800 font-semibold text-sm">
                      Prime de succès
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {successModel === "evisa"
                        ? "Due uniquement si le visa est accordé par l'autorité compétente"
                        : "Due uniquement après obtention effective d'un créneau consulaire"}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-slate-900">
                      {formatCurrency(successFee)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge paid={isSuccessFeePaid} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* TOTAUX */}
          <div className="flex justify-end">
            <div className="w-64 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Sous-total</span>
                <span className="font-semibold text-slate-800">{formatCurrency(total)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Montant payé</span>
                <span className="font-semibold text-emerald-700">−{formatCurrency(paidAmount)}</span>
              </div>
              <div
                className="flex justify-between text-sm font-bold pt-2 border-t-2 border-slate-900"
              >
                <span className="text-slate-900">Solde dû</span>
                <span
                  className={balanceDue > 0 ? "text-red-600 text-base" : "text-emerald-600 text-base"}
                >
                  {formatCurrency(balanceDue)}
                </span>
              </div>
            </div>
          </div>

          {/* STATUT GLOBAL */}
          <StatusGlobal status={app.status} />

          {/* RDV info si disponible */}
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

          {/* PAIEMENT INFO */}
          <div
            className="rounded-xl px-4 py-3 text-xs"
            style={{ background: "#F8FAFC", border: "1px solid #E2E8F0" }}
          >
            <div className="font-bold text-slate-700 mb-1.5">Modalités de paiement</div>
            <div className="text-slate-500 space-y-0.5">
              <div>Les paiements sont effectués via <strong className="text-slate-700">Mobile Money</strong> (M-Pesa, Airtel Money, Orange Money)</div>
              <div>Les justificatifs de paiement sont archivés sur la plateforme Joventy</div>
            </div>
          </div>
        </div>

        {/* ── FOOTER ── */}
        <div
          style={{ background: "#F1F5F9", borderTop: "1px solid #E2E8F0" }}
          className="px-8 py-4"
        >
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <img
                src="https://akollad.com/web-app-manifest-512x512.png"
                alt="Akollad"
                className="w-6 h-6 rounded"
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
          <div className="mt-2 text-[10px] text-slate-400 text-center">
            Ce document a valeur de facture officielle. Signature numérique archivée sur la plateforme Joventy.
            Droit applicable : République Démocratique du Congo — Juridictions de Kinshasa.
          </div>
          <div className="mt-1.5 text-[10px] text-slate-400 text-center">
            RCCM : CD/KNG/RCCM/25-A-07960 &nbsp;·&nbsp; N° Impôt : A2557944L &nbsp;·&nbsp; IDNAT : 01-J6100-N86614P
          </div>
        </div>
      </div>
    </div>
  );
}
