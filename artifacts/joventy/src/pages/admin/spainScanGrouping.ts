/**
 * spainScanGrouping.ts — Helper pur (sans dépendance React/Convex) qui regroupe
 * les lignes d'historique de scan Espagne par fenêtre (windowId) puis par cycle
 * (cycleNumber).
 *
 * Les lignes dépourvues d'identifiants (anciennes lignes sans windowId/cycleNumber)
 * tombent dans un bucket « Hors cycle » — compatibilité ascendante garantie.
 *
 * Utilisé par SpainWatcherTab (BotLogs.tsx) et SpainDossierCycles.tsx.
 */

/** Ligne de scan telle que consommée par le frontend (champs BotLogs + ids cycle/fenêtre). */
export interface SpainScanRow {
  _id: string;
  ts: number;
  status: string;
  slotInfo?: string;
  screenshotStorageId?: string;
  screenshotUrl?: string | null;
  errorMessage?: string;
  pageCaptures?: string;
  detectedServices?: string;
  detectedSlots?: string;
  scanTrace?: string;
  dossierName?: string;
  cycleNumber?: number;
  windowId?: number;
}

export interface SpainCycleGroup {
  cycleNumber: number | null;
  scans: SpainScanRow[];
}

export interface SpainWindowGroup {
  windowId: number | null;
  windowLabel: string;
  cycleCount: number;
  cycles: SpainCycleGroup[];
}

/** Libellé HH:MM (heure de Madrid) dérivé d'un windowId epoch ms. */
function formatWindowLabel(windowId: number): string {
  const d = new Date(windowId);
  return d.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  });
}

/**
 * Regroupe les scans par windowId (desc, null en dernier) puis par cycleNumber
 * (desc, null en dernier). Les lignes sans windowId sont rassemblées dans une
 * fenêtre virtuelle « Hors cycle » (windowId=null) ; au sein d'une fenêtre, les
 * lignes sans cycleNumber vont dans un cycle « Hors cycle » (cycleNumber=null).
 */
export function groupSpainScansByCycle(scans: SpainScanRow[]): SpainWindowGroup[] {
  // 1. Partition par windowId (clé "null" pour les lignes sans id).
  const windowMap = new Map<number | null, SpainScanRow[]>();
  for (const scan of scans) {
    const key = typeof scan.windowId === "number" ? scan.windowId : null;
    const bucket = windowMap.get(key);
    if (bucket) bucket.push(scan);
    else windowMap.set(key, [scan]);
  }

  // 2. Trier les fenêtres par windowId desc, null en dernier.
  const windowKeys = [...windowMap.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a;
  });

  // 3. Pour chaque fenêtre, regrouper par cycleNumber desc (null en dernier).
  return windowKeys.map((windowKey): SpainWindowGroup => {
    const rows = windowMap.get(windowKey) ?? [];

    const cycleMap = new Map<number | null, SpainScanRow[]>();
    for (const row of rows) {
      const cycleKey = typeof row.cycleNumber === "number" ? row.cycleNumber : null;
      const bucket = cycleMap.get(cycleKey);
      if (bucket) bucket.push(row);
      else cycleMap.set(cycleKey, [row]);
    }

    const cycleKeys = [...cycleMap.keys()].sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return b - a;
    });

    const cycles: SpainCycleGroup[] = cycleKeys.map((cycleKey) => ({
      cycleNumber: cycleKey,
      scans: cycleMap.get(cycleKey) ?? [],
    }));

    return {
      windowId: windowKey,
      windowLabel: windowKey === null ? "Hors cycle" : formatWindowLabel(windowKey),
      cycleCount: cycleKeys.filter((k) => k !== null).length,
      cycles,
    };
  });
}
