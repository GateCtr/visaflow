/**
 * SpainDossierCycles — Vue par dossier de l'historique des scans Espagne,
 * groupée par fenêtre puis par cycle. Affichée uniquement pour les dossiers
 * dont la destination est spain|espagne|es.
 *
 * Réutilise le helper pur groupSpainScansByCycle (via SpainCycleGroupedList)
 * et les mêmes composants de trace que l'onglet admin Espagne (BotLogs.tsx),
 * sans duplication de markup.
 */
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Flag, RefreshCw } from "lucide-react";
import { SpainCycleGroupedList } from "../spainScanTrace";
import type { SpainScanRow } from "../spainScanGrouping";

export function SpainDossierCycles({ applicationId }: { applicationId: string }) {
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const data = useQuery(api.spainWatcher.getScansForDossier, {
    applicationId,
    page,
    pageSize,
  });

  const scans = data?.scans ?? [];
  const totalPages = data?.totalPages ?? 0;
  const totalCount = data?.totalCount ?? 0;
  const safePage = Math.min(page, Math.max(0, totalPages - 1));

  return (
    <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
          <Flag className="w-4 h-4 text-red-500" />
          Scans Espagne par cycle
          {totalCount > 0 && (
            <span className="ml-1 text-[10px] text-muted-foreground bg-slate-100 px-1.5 py-0.5 rounded-full">{totalCount}</span>
          )}
        </h3>
      </div>

      {data === undefined ? (
        <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
          <RefreshCw className="w-4 h-4 animate-spin" /><span className="text-sm">...</span>
        </div>
      ) : scans.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-10">Aucun scan pour ce dossier.</p>
      ) : (
        <>
          <SpainCycleGroupedList scans={scans as unknown as SpainScanRow[]} />

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 px-4 py-3 border-t border-slate-100 bg-slate-50/50 mt-3 rounded-lg">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-400 disabled:opacity-30"
              >
                ‹ Précédent
              </button>
              <span className="text-[9px] text-slate-400">
                {safePage + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={safePage >= totalPages - 1}
                className="text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-400 disabled:opacity-30"
              >
                Suivant ›
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
