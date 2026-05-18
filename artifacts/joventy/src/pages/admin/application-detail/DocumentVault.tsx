/**
 * DocumentVault — Coffre-fort documents client + admin.
 */
import { Doc } from "@convex/_generated/dataModel";
import { Id } from "@convex/_generated/dataModel";
import { getUploadDocs } from "@convex/visaDocuments";
import { FileText, AlertTriangle } from "lucide-react";
import { DocUploadRow } from "./components/DocUploadRow";
import { AdminCustomDocUpload } from "./components/AdminCustomDocUpload";

interface Props {
  appId: Id<"applications">;
  destination: string;
  visaType: string;
  servicePackage: string;
  docs: Array<Doc<"documents"> & { url?: string | null }>;
}

export function DocumentVault({ appId, destination, visaType, servicePackage, docs }: Props) {
  const uploadDocs = getUploadDocs(destination, visaType);
  const clientDocs = docs.filter(d => !d.isAdminUpload);
  const adminDocs = docs.filter(d => d.isAdminUpload);
  const isSlotOnly = servicePackage === "slot_only";

  const docsByKey = Object.fromEntries(
    clientDocs.map(d => [d.docKey, { _id: d._id, url: d.url ?? null, verifiedByAdmin: d.verifiedByAdmin, isAdminUpload: d.isAdminUpload }])
  );

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-400 to-blue-500 flex items-center justify-center">
            <FileText className="w-4 h-4 text-white" />
          </div>
          <h2 className="font-semibold text-slate-800 text-sm">Documents</h2>
        </div>
        <span className="text-xs text-slate-400 font-mono">{clientDocs.length}/{uploadDocs.length}</span>
      </div>

      <div className="p-6 space-y-5">
        {isSlotOnly && (
          <div className="flex items-start gap-2.5 px-3 py-2.5 bg-purple-50/60 border border-purple-200/50 rounded-lg text-[12px] text-purple-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Package Créneau — documents optionnels sur la plateforme.</span>
          </div>
        )}

        {/* Client docs */}
        <div>
          <p className="text-[11px] text-slate-400 uppercase font-semibold tracking-wide mb-2">Documents client</p>
          {uploadDocs.map(doc => (
            <DocUploadRow key={doc.key} appId={appId} docKey={doc.key} label={doc.label}
              required={isSlotOnly ? false : doc.required} existingDoc={docsByKey[doc.key]} />
          ))}
        </div>

        {/* Admin docs */}
        <div>
          <p className="text-[11px] text-slate-400 uppercase font-semibold tracking-wide mb-2">Documents admin</p>
          {adminDocs.map(doc => (
            <DocUploadRow key={`admin-${doc._id}`} appId={appId} docKey={doc.docKey} label={doc.label}
              required={false} existingDoc={{ _id: doc._id, url: doc.url ?? null, verifiedByAdmin: doc.verifiedByAdmin, isAdminUpload: doc.isAdminUpload }} />
          ))}
          {adminDocs.length === 0 && <p className="text-xs text-slate-400 italic py-1">Aucun document admin.</p>}
          <AdminCustomDocUpload appId={appId} />
        </div>
      </div>
    </div>
  );
}
