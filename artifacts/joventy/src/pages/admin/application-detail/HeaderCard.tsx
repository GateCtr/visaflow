/**
 * Header card — infos client, status, package, tracking link.
 */
import { useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateOnly } from "@/lib/format";
import { SERVICE_PACKAGES } from "@convex/constants";
import { User, Package, Link, Check, FileText } from "lucide-react";

interface Props {
  app: {
    _id: string;
    destination: string;
    visaType: string;
    applicantName: string;
    status: string;
    userFirstName: string;
    userLastName: string;
    userEmail?: string;
    userPhone?: string;
    passportNumber?: string;
    travelDate?: string;
    returnDate?: string;
    purpose?: string;
    notes?: string;
    [key: string]: unknown;
  };
  servicePackage: string;
  isDossierOnly: boolean;
  isSlotOnly: boolean;
}

export function HeaderCard({ app, servicePackage, isDossierOnly, isSlotOnly }: Props) {
  const [trackingCopied, setTrackingCopied] = useState(false);
  const trackingToken = (app as { trackingToken?: string }).trackingToken;
  const userWhatsapp = (app as { userWhatsapp?: string }).userWhatsapp;

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      {/* Top bar with gradient */}
      <div className="h-1.5 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500" />

      <div className="p-6 lg:p-8">
        {/* Title row */}
        <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-slate-900 tracking-tight">
              {app.destination.toUpperCase()} — {app.visaType}
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              Ref : <span className="font-mono font-medium text-slate-600">JOV-{app._id.slice(-5).toUpperCase()}</span>
              {" · "}{app.applicantName}
            </p>
          </div>

          <div className="flex flex-col items-end gap-2">
            <StatusBadge status={app.status} />
            <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full ${
              isDossierOnly
                ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200/60"
                : isSlotOnly
                  ? "bg-purple-50 text-purple-700 ring-1 ring-purple-200/60"
                  : "bg-amber-50 text-amber-700 ring-1 ring-amber-200/60"
            }`}>
              <Package className="w-3 h-3" />
              {SERVICE_PACKAGES[servicePackage as keyof typeof SERVICE_PACKAGES]?.label ?? "Service Complet"}
            </span>
            {trackingToken && (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`https://joventy.cd/suivi/${trackingToken}`);
                  setTrackingCopied(true);
                  setTimeout(() => setTrackingCopied(false), 2000);
                }}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
              >
                {trackingCopied
                  ? <><Check className="w-3 h-3 text-green-600" /><span className="text-green-600">Copié</span></>
                  : <><Link className="w-3 h-3" />Lien de suivi</>}
              </button>
            )}
          </div>
        </div>

        {/* Info grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <InfoCell
            icon={<User className="w-4 h-4 text-slate-400" />}
            label="Client"
            value={`${app.userFirstName} ${app.userLastName}`}
            sub={[app.userEmail, app.userPhone, userWhatsapp].filter(Boolean).join(" · ")}
          />
          <InfoCell
            icon={<FileText className="w-4 h-4 text-slate-400" />}
            label="Passeport"
            value={app.passportNumber || "Non renseigné"}
          />
          <InfoCell
            label="Voyage"
            value={app.travelDate ? formatDateOnly(app.travelDate) : "—"}
            sub={app.returnDate ? `Retour : ${formatDateOnly(app.returnDate)}` : undefined}
          />
          <InfoCell
            label="Motif"
            value={app.purpose || "—"}
          />
        </div>

        {/* Notes client */}
        {app.notes && (
          <div className="mt-4 px-4 py-3 bg-slate-50 rounded-xl border border-slate-100">
            <p className="text-[11px] text-slate-400 uppercase font-semibold tracking-wide mb-1">Notes client</p>
            <p className="text-sm text-slate-600 italic leading-relaxed">{app.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCell({ icon, label, value, sub }: { icon?: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="px-4 py-3 rounded-xl bg-slate-50/80 border border-slate-100/80">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <p className="text-[10px] text-slate-400 uppercase font-semibold tracking-wider">{label}</p>
      </div>
      <p className="text-sm font-semibold text-slate-800 truncate">{value}</p>
      {sub && <p className="text-[11px] text-slate-500 mt-0.5 truncate">{sub}</p>}
    </div>
  );
}
