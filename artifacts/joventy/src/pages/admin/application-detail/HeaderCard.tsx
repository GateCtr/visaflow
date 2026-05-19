/**
 * HeaderCard — Compact inline header inspired by Linear/Notion.
 * Single-row on desktop, stacked on mobile. Maximum info density.
 */
import { useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateOnly } from "@/lib/format";
import { SERVICE_PACKAGES } from "@convex/constants";
import { User, Package, Link, Check, Copy, Plane, MapPin, Phone, Mail } from "lucide-react";

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
  const [refCopied, setRefCopied] = useState(false);
  const trackingToken = (app as { trackingToken?: string }).trackingToken;
  const userWhatsapp = (app as { userWhatsapp?: string }).userWhatsapp;
  const ref = `JOV-${app._id.slice(-5).toUpperCase()}`;

  const copyRef = () => {
    navigator.clipboard.writeText(ref);
    setRefCopied(true);
    setTimeout(() => setRefCopied(false), 1500);
  };

  const copyTracking = () => {
    navigator.clipboard.writeText(`https://joventy.cd/suivi/${trackingToken}`);
    setTrackingCopied(true);
    setTimeout(() => setTrackingCopied(false), 2000);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
      {/* Thin accent bar */}
      <div className="h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500" />

      <div className="px-4 py-3 lg:px-6 lg:py-4">
        {/* Row 1: Title + Status + Package */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Destination badge */}
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center shrink-0">
              <span className="text-[10px] font-bold text-white tracking-tight">
                {app.destination.slice(0, 2).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-bold text-slate-900 tracking-tight truncate">
                {app.destination.toUpperCase()} · {app.visaType}
              </h1>
            </div>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Status + Package badges */}
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <StatusBadge status={app.status} />
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                isDossierOnly
                  ? "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200/60"
                  : isSlotOnly
                    ? "bg-purple-50 text-purple-700 ring-1 ring-inset ring-purple-200/60"
                    : "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200/60"
              }`}
            >
              <Package className="w-2.5 h-2.5" />
              {SERVICE_PACKAGES[servicePackage as keyof typeof SERVICE_PACKAGES]?.label ?? "Complet"}
            </span>
          </div>
        </div>

        {/* Row 2: Meta info chips */}
        <div className="flex items-center gap-2 mt-2.5 flex-wrap text-[11px]">
          {/* Ref */}
          <button
            onClick={copyRef}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-50 border border-slate-150 text-slate-600 font-mono hover:bg-slate-100 transition-colors"
          >
            {refCopied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3 text-slate-400" />}
            {ref}
          </button>

          {/* Client name */}
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-50 border border-slate-150 text-slate-600">
            <User className="w-3 h-3 text-slate-400" />
            {app.userFirstName} {app.userLastName}
          </span>

          {/* Contact (condensed) */}
          {app.userEmail && (
            <span className="hidden md:inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-50 border border-slate-150 text-slate-500">
              <Mail className="w-3 h-3 text-slate-400" />
              <span className="truncate max-w-[140px]">{app.userEmail}</span>
            </span>
          )}
          {(app.userPhone || userWhatsapp) && (
            <span className="hidden lg:inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-50 border border-slate-150 text-slate-500">
              <Phone className="w-3 h-3 text-slate-400" />
              {app.userPhone || userWhatsapp}
            </span>
          )}

          {/* Travel date */}
          {app.travelDate && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-50 border border-slate-150 text-slate-600">
              <Plane className="w-3 h-3 text-slate-400" />
              {formatDateOnly(app.travelDate)}
            </span>
          )}

          {/* Passport */}
          {app.passportNumber && (
            <span className="hidden xl:inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-50 border border-slate-150 text-slate-600 font-mono">
              {app.passportNumber}
            </span>
          )}

          {/* Tracking link */}
          {trackingToken && (
            <button
              onClick={copyTracking}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-50 border border-blue-200/60 text-blue-600 hover:bg-blue-100 transition-colors font-medium"
            >
              {trackingCopied ? (
                <><Check className="w-3 h-3 text-emerald-500" /><span className="text-emerald-600">Copié</span></>
              ) : (
                <><Link className="w-3 h-3" />Suivi</>
              )}
            </button>
          )}
        </div>

        {/* Row 3: Notes (collapsible on mobile) */}
        {app.notes && (
          <p className="mt-2 text-xs text-slate-500 italic leading-relaxed line-clamp-2 px-1">
            💬 {app.notes}
          </p>
        )}
      </div>
    </div>
  );
}
