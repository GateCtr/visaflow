/**
 * analyze-sync-log.ts — Preuve mesurable de la synchronisation de grille.
 *
 * Parse un log produit par test-worker-multi-portal.ts et PROUVE, par front de
 * grille (fronts absolus de `tick` ms), que les workers regardent `datetime/`
 * quasi simultanément et voient le MÊME état à l'instant T :
 *   - São Paulo : tous voient `found` (créneaux) au même front,
 *   - Kinshasa  : tous voient `not_found` (agenda vide) au même front.
 *
 * Aucune réimplémentation : on lit UNIQUEMENT les lignes déjà émises par le code
 * prod (`📊 Cycle N scan=STATUS`), horodatées en ISO. On regroupe les scans par
 * bucket de front (floor(ts / tick) * tick) et on mesure :
 *   - le nombre de workers distincts ayant scanné dans le même front,
 *   - la dispersion temporelle intra-front (max - min, en ms) → alignement,
 *   - l'accord des statuts (tous found / tous not_found) → même vue à l'instant T.
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/analyze-sync-log.ts <fichier.log> [tickMs=10000]
 */
import { readFileSync } from "node:fs";

/**
 * Lit un fichier log en détectant l'encodage via BOM. PowerShell `Tee-Object` écrit
 * en UTF-16 LE (BOM FF FE) ; Node/tsx écrit en UTF-8. On gère les deux pour que
 * l'analyseur soit robuste quelle que soit l'origine du log.
 */
function readLogFile(path: string): string {
  const buf = readFileSync(path);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE : swap des octets puis décodage LE.
    const swapped = Buffer.alloc(buf.length);
    for (let i = 0; i + 1 < buf.length; i += 2) {
      swapped[i] = buf[i + 1];
      swapped[i + 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8");
}

// ─── Arguments ────────────────────────────────────────────────────────────────

const LOG_PATH = process.argv[2];
const TICK_MS = Number(process.argv[3] ?? "10000");

if (!LOG_PATH) {
  console.error("Usage: npx tsx src/scripts/analyze-sync-log.ts <fichier.log> [tickMs=10000]");
  process.exit(1);
}

// ─── Modèle d'observation ─────────────────────────────────────────────────────

interface ScanObservation {
  tsMs: number;
  worker: string;
  cycle: number;
  status: string;
}

/**
 * Parse les lignes de scan du log. Format émis par spain-dossier-worker.ts :
 *   [2026-08-31T08:56:47.413Z] [INFO] [WORKER:SÃO PAULO 3] 📊 Cycle 1 scan=found | …
 * On extrait timestamp ISO, label worker, numéro de cycle, statut.
 */
function parseScans(raw: string): ScanObservation[] {
  const out: ScanObservation[] = [];
  const re =
    /^\[(?<iso>\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*\[WORKER:(?<worker>[^\]]+)\].*Cycle\s+(?<cycle>\d+)\s+scan=(?<status>[a-z_]+)/u;
  for (const line of raw.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m?.groups) {
      const tsMs = Date.parse(m.groups.iso);
      if (!Number.isNaN(tsMs)) {
        out.push({
          tsMs,
          worker: m.groups.worker.trim(),
          cycle: Number(m.groups.cycle),
          status: m.groups.status,
        });
      }
    }
  }
  return out;
}

// ─── Durée réelle de scan par worker ─────────────────────────────────────────
//
// Le worker n'émet pas directement la durée d'un cycle. On la RECONSTRUIT depuis le
// log : durée de scan = intervalle entre le réveil sur front (`wake front reached`)
// d'un cycle et le `📊 Cycle N scan=` qui suit IMMÉDIATEMENT pour le même worker.
// C'est le temps réel du cycle datetime/ (main → getservices → getagendas → datetime),
// distinct de la dispersion inter-workers. C'est LE chiffre qui borne l'intervalle min.

interface WakeEvent {
  tsMs: number;
  worker: string;
}

function parseWakes(raw: string): WakeEvent[] {
  const out: WakeEvent[] = [];
  const re =
    /^\[(?<iso>\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*\[WORKER:(?<worker>[^\]]+)\].*wake front reached/u;
  for (const line of raw.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m?.groups) {
      const tsMs = Date.parse(m.groups.iso);
      if (!Number.isNaN(tsMs)) out.push({ tsMs, worker: m.groups.worker.trim() });
    }
  }
  return out;
}

/**
 * Mesure les durées de scan : pour chaque `📊 scan=`, on cherche le dernier `wake`
 * du même worker qui le précède (dans une fenêtre raisonnable) et on prend l'écart.
 * Retourne la liste des durées (ms) et des statistiques.
 */
function measureScanDurations(
  scans: ScanObservation[],
  wakes: WakeEvent[],
): { durationsMs: number[]; stats: { count: number; minMs: number; avgMs: number; p95Ms: number; maxMs: number } | null } {
  // Index des wakes par worker, triés par temps.
  const wakesByWorker = new Map<string, number[]>();
  for (const w of wakes) {
    const arr = wakesByWorker.get(w.worker) ?? [];
    arr.push(w.tsMs);
    wakesByWorker.set(w.worker, arr);
  }
  for (const arr of wakesByWorker.values()) arr.sort((a, b) => a - b);

  const durationsMs: number[] = [];
  for (const scan of scans) {
    const wakeTimes = wakesByWorker.get(scan.worker);
    if (!wakeTimes) continue;
    // Dernier wake strictement avant le scan.
    let best = -1;
    for (const t of wakeTimes) {
      if (t < scan.tsMs) best = t;
      else break;
    }
    if (best >= 0) {
      const d = scan.tsMs - best;
      // Filtre les aberrations (recovery/backoff entre wake et scan) : on garde les
      // durées plausibles d'un cycle datetime/ (< 30 s).
      if (d > 0 && d < 30_000) durationsMs.push(d);
    }
  }

  if (durationsMs.length === 0) return { durationsMs, stats: null };
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    durationsMs,
    stats: {
      count: sorted.length,
      minMs: sorted[0],
      avgMs: Math.round(sum / sorted.length),
      p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      maxMs: sorted[sorted.length - 1],
    },
  };
}

// ─── Regroupement par front de grille ─────────────────────────────────────────

interface FrontBucket {
  front: number;
  observations: ScanObservation[];
}

function bucketByFront(obs: ScanObservation[], tickMs: number): FrontBucket[] {
  const map = new Map<number, ScanObservation[]>();
  for (const o of obs) {
    const front = Math.floor(o.tsMs / tickMs) * tickMs;
    const arr = map.get(front) ?? [];
    arr.push(o);
    map.set(front, arr);
  }
  return [...map.entries()]
    .map(([front, observations]) => ({ front, observations }))
    .sort((a, b) => a.front - b.front);
}

// ─── Rapport ──────────────────────────────────────────────────────────────────

function main(): void {
  const raw = readLogFile(LOG_PATH);
  const obs = parseScans(raw);

  if (obs.length === 0) {
    console.error(`Aucune observation de scan trouvée dans ${LOG_PATH}.`);
    process.exit(1);
  }

  const workers = new Set(obs.map((o) => o.worker));
  const totalWorkers = workers.size;

  console.log(`\n${"═".repeat(74)}`);
  console.log(`  PREUVE DE SYNCHRONISATION — ${LOG_PATH}`);
  console.log(`  tick=${TICK_MS}ms | ${obs.length} scans | ${totalWorkers} workers distincts`);
  console.log(`${"═".repeat(74)}\n`);

  // ── Durée réelle de scan par worker (borne l'intervalle minimum viable) ──────
  const wakes = parseWakes(raw);
  const { stats } = measureScanDurations(obs, wakes);
  if (stats) {
    console.log("  ⏱️  DURÉE RÉELLE D'UN SCAN (cycle datetime/ complet, par worker) :");
    console.log(
      `      n=${stats.count} | min=${(stats.minMs / 1000).toFixed(1)}s | moy=${(stats.avgMs / 1000).toFixed(1)}s | ` +
        `p95=${(stats.p95Ms / 1000).toFixed(1)}s | max=${(stats.maxMs / 1000).toFixed(1)}s`,
    );
    // Recommandation d'intervalle : p95 + marge 40% + plancher métier 2700ms.
    const recommended = Math.max(2700, Math.round((stats.p95Ms * 1.4) / 100) * 100);
    console.log(
      `      → intervalle min viable ≈ p95×1.4 = ${(recommended / 1000).toFixed(1)}s ` +
        `(le tick doit rester ≥ durée de scan pour éviter le chevauchement de cycles)\n`,
    );
  }

  const buckets = bucketByFront(obs, TICK_MS);

  // On ne considère "fronts synchronisés" que ceux où ≥ 2 workers distincts ont
  // scanné (un front avec 1 seul worker ne prouve rien sur la synchro d'essaim).
  const syncFronts = buckets.filter(
    (b) => new Set(b.observations.map((o) => o.worker)).size >= 2,
  );

  console.log(`Fronts avec ≥ 2 workers (candidats synchro) : ${syncFronts.length}\n`);

  let bestFront: FrontBucket | null = null;
  let bestCount = 0;

  for (const b of syncFronts) {
    const distinctWorkers = new Set(b.observations.map((o) => o.worker));
    const timestamps = b.observations.map((o) => o.tsMs);
    const spreadMs = Math.max(...timestamps) - Math.min(...timestamps);
    const statuses = new Set(b.observations.map((o) => o.status));
    const frontIso = new Date(b.front).toISOString();
    const agreed = statuses.size === 1 ? [...statuses][0] : `MIXTE(${[...statuses].join(",")})`;

    console.log(
      `  Front ${frontIso} → ${distinctWorkers.size}/${totalWorkers} workers | ` +
        `dispersion ${spreadMs}ms | statut ${agreed}`,
    );

    if (distinctWorkers.size > bestCount) {
      bestCount = distinctWorkers.size;
      bestFront = b;
    }
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(74)}`);
  if (bestFront) {
    const distinctWorkers = new Set(bestFront.observations.map((o) => o.worker));
    const timestamps = bestFront.observations.map((o) => o.tsMs);
    const spreadMs = Math.max(...timestamps) - Math.min(...timestamps);
    const statuses = new Set(bestFront.observations.map((o) => o.status));
    console.log(`  MEILLEUR FRONT (instant T) : ${new Date(bestFront.front).toISOString()}`);
    console.log(`    → ${distinctWorkers.size}/${totalWorkers} workers ont scanné dans la même fenêtre de ${TICK_MS}ms`);
    console.log(`    → dispersion temporelle : ${spreadMs}ms (alignement de grille)`);
    console.log(
      `    → vue commune : ${statuses.size === 1 ? `TOUS "${[...statuses][0]}"` : `divergente (${[...statuses].join(",")})`}`,
    );
    console.log(
      `\n  ${statuses.size === 1 && distinctWorkers.size >= 2 ? "✅" : "⚠️"} ` +
        `À l'instant T, ${distinctWorkers.size} workers voient le MÊME état "${[...statuses][0] ?? "?"}"`,
    );
  } else {
    console.log("  ⚠️ Aucun front avec ≥ 2 workers — synchronisation non démontrable sur ce log.");
    console.log("     (fenêtre trop courte, ou init trop étalée : les workers n'ont pas convergé)");
  }
  console.log(`${"─".repeat(74)}\n`);
}

main();
