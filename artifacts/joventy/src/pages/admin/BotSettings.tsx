/**
 * BotSettings — Configuration Hunter Bot.
 *
 * Layout moderne pro inspiré Linear/Notion :
 * - Header compact avec status indicator
 * - Navigation latérale par catégorie (tabs sur mobile)
 * - Config items denses en grid 2-col
 * - Toggles inline, saves immédiats
 * - Raw config collapsible en bas
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  Settings,
  Zap,
  Clock,
  Shield,
  Server,
  RefreshCw,
  Save,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Target,
  ChevronDown,
  ChevronRight,
  Terminal,
} from "lucide-react";

// ─── Configuration keys et leurs descriptions ────────────────────────────────

interface ConfigItem {
  key: string;
  label: string;
  description: string;
  type: "toggle" | "number" | "text" | "select";
  category: "mode" | "timing" | "protection" | "proxy" | "prediction" | "v3strategy";
  defaultValue: string;
  options?: { value: string; label: string }[];
  unit?: string;
  min?: number;
  max?: number;
}

const CONFIG_ITEMS: ConfigItem[] = [
  // ─── Mode d'execution
  {
    key: "v3_mode",
    label: "Mode V3 Chasseur",
    description: "Boucle V3 (runScanSession + getNextScanDecision). Prioritaire sur parallèle/séquentiel.",
    type: "toggle",
    category: "mode",
    defaultValue: "0",
  },
  {
    key: "parallel_watcher_mode",
    label: "Mode Parallèle (Watcher OFC)",
    description: "Watcher partagé + booking race. 1 refresh/45s pour tous les dossiers Kinshasa.",
    type: "toggle",
    category: "mode",
    defaultValue: "0",
  },
  {
    key: "cev_stealth_mode",
    label: "CEV Stealth Mode v2 (Belgique)",
    description: "Pool d'IPs rotatif iProyal + session VOWINT persistante. Couverture 24/7 sans rate-limit. Désactive les loops CEV classiques.",
    type: "toggle",
    category: "mode",
    defaultValue: "0",
  },
  {
    key: "cev_stealth_pool_size",
    label: "CEV Pool Size (IPs)",
    description: "Nombre d'IPs iProyal dans le pool. 4 IPs = 16 checks/h ($1.92/j), 6 IPs = 24 checks/h ($2.64/j), 8 IPs = 32 checks/h ($3.84/j).",
    type: "number",
    category: "mode",
    defaultValue: "6",
    unit: "IPs",
    min: 2,
    max: 30,
  },
  {
    key: "cev_stealth_checks_per_cycle",
    label: "CEV Checks/Cycle",
    description: "Nombre de checks par IP avant rotation. 4 = max sécuritaire (limite serveur = 5).",
    type: "number",
    category: "mode",
    defaultValue: "4",
    unit: "checks",
    min: 1,
    max: 5,
  },
  {
    key: "cev_stealth_pause_between_checks",
    label: "CEV Pause inter-checks",
    description: "Secondes entre chaque check dans un cycle. Plus bas = plus rapide mais plus de trafic proxy.",
    type: "number",
    category: "mode",
    defaultValue: "20",
    unit: "secondes",
    min: 5,
    max: 60,
  },
  {
    key: "cev_stealth_proxy_provider",
    label: "CEV Proxy Provider",
    description: "Provider proxy pour le pool CEV stealth. SOAX = sessions 10h + ciblage Kinshasa. iProyal = sessions 60min. Auto = SOAX si configuré, sinon iProyal.",
    type: "select",
    category: "mode",
    defaultValue: "auto",
    options: [
      { value: "auto", label: "Auto (SOAX > iProyal)" },
      { value: "soax", label: "SOAX (191M IPs, sessions 10h)" },
      { value: "iproyal", label: "iProyal (sessions 60min)" },
    ],
  },
  {
    key: "cev_dossier_mode",
    label: "CEV Dossier Mode v3",
    description: "Pool de DOSSIERS (pas d'IPs). 5 dossiers × 5 clics/h = 25 scans/h = 1 scan/2.5min. Remplace le stealth loop v2.",
    type: "toggle",
    category: "mode",
    defaultValue: "0",
  },
  {
    key: "cev_dossier_pool",
    label: "CEV Dossiers (VOWINT)",
    description: "Liste de numéros VOWINT séparés par virgule. Ex: VOWINT6085888,VOWINT6085889,VOWINT6085890",
    type: "text",
    category: "mode",
    defaultValue: "",
  },
  {
    key: "cev_dossier_interval_sec",
    label: "CEV Dossier Intervalle",
    description: "Secondes entre chaque scan. 0 = auto-calculé (60min ÷ dossiers × 4). Avec 5 dossiers = ~150s.",
    type: "number",
    category: "mode",
    defaultValue: "0",
    unit: "sec",
    min: 0,
    max: 600,
  },
  // ─── Timing / Intervalles
  {
    key: "watcher_base_interval_ms",
    label: "Intervalle Watcher",
    description: "Base entre deux refreshes. Adapté auto selon prediction + latence.",
    type: "number",
    category: "timing",
    defaultValue: "45000",
    unit: "ms",
    min: 15000,
    max: 180000,
  },
  {
    key: "rush_interval_min_ms",
    label: "Rush Min",
    description: "Intervalle minimum pendant les rush hours (00-02h, 07-09h, 12-14h).",
    type: "number",
    category: "timing",
    defaultValue: "300000",
    unit: "ms",
    min: 60000,
    max: 600000,
  },
  {
    key: "rush_interval_max_ms",
    label: "Rush Max",
    description: "Intervalle maximum pendant les rush hours.",
    type: "number",
    category: "timing",
    defaultValue: "420000",
    unit: "ms",
    min: 120000,
    max: 900000,
  },
  // ─── Protection / Anti-detection
  {
    key: "scan_cap_min",
    label: "Cap Scans Min",
    description: "Minimum scans avant arrêt forcé de session.",
    type: "number",
    category: "protection",
    defaultValue: "6",
    min: 3,
    max: 20,
  },
  {
    key: "scan_cap_max",
    label: "Cap Scans Max",
    description: "Maximum scans par session avant pause forcée.",
    type: "number",
    category: "protection",
    defaultValue: "10",
    min: 5,
    max: 30,
  },
  {
    key: "cooldown_min_ms",
    label: "Cooldown Min",
    description: "Attente min après expiration JWT avant re-login.",
    type: "number",
    category: "protection",
    defaultValue: "480000",
    unit: "ms",
    min: 120000,
    max: 1800000,
  },
  {
    key: "cooldown_max_ms",
    label: "Cooldown Max",
    description: "Attente max après expiration JWT.",
    type: "number",
    category: "protection",
    defaultValue: "1500000",
    unit: "ms",
    min: 300000,
    max: 3600000,
  },
  {
    key: "night_pause_enabled",
    label: "Pause Nocturne",
    description: "Pause 02h30-06h30 variable par compte. Désactiver pour scanner 24/24.",
    type: "toggle",
    category: "protection",
    defaultValue: "1",
  },
  // ─── Prediction Early Bird
  {
    key: "prediction_min_observations",
    label: "Observations Min",
    description: "Slots détectés minimum avant activation prediction.",
    type: "number",
    category: "prediction",
    defaultValue: "1",
    min: 1,
    max: 10,
  },
  {
    key: "prediction_hot_threshold",
    label: "Seuil Hot Window",
    description: "Score min (0-1) pour tranche 'chaude' (refresh accéléré).",
    type: "number",
    category: "prediction",
    defaultValue: "0.4",
    min: 0.1,
    max: 0.9,
  },
  {
    key: "prediction_history_days",
    label: "Historique (jours)",
    description: "Jours d'historique pour prédiction des fenêtres.",
    type: "number",
    category: "prediction",
    defaultValue: "7",
    min: 1,
    max: 30,
  },
  // ─── Proxy
  {
    key: "proxy_priority",
    label: "Priorité Proxy",
    description: "Ordre de préférence des providers.",
    type: "select",
    category: "proxy",
    defaultValue: "iproyal,soax,brightdata,2captcha",
    options: [
      { value: "iproyal,soax,brightdata,2captcha", label: "iProyal > SOAX > BrightData > 2captcha" },
      { value: "soax,iproyal,brightdata,2captcha", label: "SOAX > iProyal > BrightData > 2captcha" },
      { value: "soax,brightdata,2captcha", label: "SOAX > BrightData > 2captcha (sans iProyal)" },
      { value: "iproyal,brightdata,2captcha", label: "iProyal > BrightData > 2captcha (sans SOAX)" },
      { value: "brightdata,iproyal,2captcha", label: "BrightData > iProyal > 2captcha" },
      { value: "2captcha,iproyal,brightdata", label: "2captcha > iProyal > BrightData" },
      { value: "soax", label: "SOAX uniquement" },
      { value: "2captcha", label: "2captcha uniquement" },
    ],
  },
  {
    key: "proxy_sticky_lifetime_h",
    label: "Sticky Proxy (h)",
    description: "Durée de vie proxy sticky iProyal. Nouvelle IP après expiration.",
    type: "number",
    category: "proxy",
    defaultValue: "12",
    unit: "h",
    min: 1,
    max: 24,
  },
  // ─── V3 Stratégie Multi-Compte
  {
    key: "accountRole",
    label: "Rôle Compte",
    description: "Éclaireur (scan + broadcast), Confiné (reçoit bookings), Hybride.",
    type: "select",
    category: "v3strategy",
    defaultValue: "hybride",
    options: [
      { value: "eclaireur", label: "Éclaireur" },
      { value: "confine", label: "Confiné" },
      { value: "hybride", label: "Hybride" },
    ],
  },
  {
    key: "currentAppointmentDate",
    label: "Date RDV Actuel",
    description: "YYYY-MM-DD. Auto-détection du rôle selon proximité.",
    type: "text",
    category: "v3strategy",
    defaultValue: "",
  },
  {
    key: "maxLoginsPerDay",
    label: "Logins/Jour",
    description: "Budget logins quotidien (max absolu: 10).",
    type: "number",
    category: "v3strategy",
    defaultValue: "9",
    min: 1,
    max: 10,
  },
  {
    key: "rushWindows",
    label: "Rush Windows (JSON)",
    description: 'Fenêtres personnalisées. Ex: [{"start":0,"end":2}]',
    type: "text",
    category: "v3strategy",
    defaultValue: "",
  },
  {
    key: "blindBookingEnabled",
    label: "Blind Booking",
    description: "Éclaireur broadcast → confinés réservent auto.",
    type: "toggle",
    category: "v3strategy",
    defaultValue: "0",
  },
  {
    key: "slotPriorityDates",
    label: "Dates Prioritaires",
    description: "Patterns wildcard. Ex: 2026-09-*,2026-10-15",
    type: "text",
    category: "v3strategy",
    defaultValue: "",
  },
  {
    key: "maxMonthsToScan",
    label: "Mois à Scanner",
    description: "Mois max à naviguer dans le calendrier OFC.",
    type: "number",
    category: "v3strategy",
    defaultValue: "3",
    min: 1,
    max: 12,
  },
  {
    key: "nightModeEnabled",
    label: "Mode Nuit (02h UTC)",
    description: "Login nocturne dédié pour slots libérés la nuit.",
    type: "toggle",
    category: "v3strategy",
    defaultValue: "1",
  },
  {
    key: "preferredProxy",
    label: "Proxy Préféré",
    description: "Override la priorité globale pour ce dossier.",
    type: "select",
    category: "v3strategy",
    defaultValue: "",
    options: [
      { value: "", label: "Défaut" },
      { value: "iproyal", label: "iProyal" },
      { value: "soax", label: "SOAX" },
      { value: "brightdata", label: "BrightData" },
      { value: "2captcha", label: "2captcha" },
    ],
  },
];

// ─── Catégories ──────────────────────────────────────────────────────────────

const CATEGORIES = [
  { id: "v3strategy", label: "V3 Stratégie", shortLabel: "V3", icon: Target, color: "text-indigo-600", bg: "bg-indigo-50", border: "border-indigo-200" },
  { id: "mode", label: "Exécution", shortLabel: "Mode", icon: Zap, color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-200" },
  { id: "timing", label: "Timing", shortLabel: "Time", icon: Clock, color: "text-blue-600", bg: "bg-blue-50", border: "border-blue-200" },
  { id: "protection", label: "Protection", shortLabel: "Sécu", icon: Shield, color: "text-red-600", bg: "bg-red-50", border: "border-red-200" },
  { id: "prediction", label: "Prédiction", shortLabel: "Pred", icon: RefreshCw, color: "text-purple-600", bg: "bg-purple-50", border: "border-purple-200" },
  { id: "proxy", label: "Proxy", shortLabel: "Proxy", icon: Server, color: "text-emerald-600", bg: "bg-emerald-50", border: "border-emerald-200" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

// ─── Composant Principal ─────────────────────────────────────────────────────

export default function BotSettings() {
  const allConfigs = useQuery(api.hunter.listBotConfig);
  const setBotConfig = useMutation(api.hunter.setBotConfig);
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategoryId>("v3strategy");
  const [showRaw, setShowRaw] = useState(false);

  // Hydrate
  useEffect(() => {
    if (!allConfigs) return;
    const vals: Record<string, string> = {};
    for (const row of allConfigs) {
      vals[row.key] = row.value;
    }
    setLocalValues(vals);
  }, [allConfigs]);

  const getValue = (key: string, defaultValue: string): string => {
    return localValues[key] ?? defaultValue;
  };

  const handleSave = async (key: string, value: string) => {
    setSaving(key);
    try {
      await setBotConfig({ key, value });
      setLocalValues((prev) => ({ ...prev, [key]: value }));
      setSaved(key);
      setTimeout(() => setSaved(null), 2000);
    } catch (err) {
      console.error("Erreur save bot config:", err);
    } finally {
      setSaving(null);
    }
  };

  const handleToggle = (item: ConfigItem) => {
    const current = getValue(item.key, item.defaultValue);
    const newValue = current === "1" ? "0" : "1";
    setLocalValues((prev) => ({ ...prev, [item.key]: newValue }));
    handleSave(item.key, newValue);
  };

  if (!allConfigs) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        <span className="ml-2 text-sm text-slate-500">Chargement configuration...</span>
      </div>
    );
  }

  const activeItems = CONFIG_ITEMS.filter((i) => i.category === activeCategory);
  const activeCat = CATEGORIES.find((c) => c.id === activeCategory)!;

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* ═══ HEADER COMPACT ═══ */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center">
            <Settings className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900 tracking-tight">Hunter Bot Config</h1>
            <p className="text-[11px] text-slate-500">
              {allConfigs.length} clé{allConfigs.length > 1 ? "s" : ""} enregistrée{allConfigs.length > 1 ? "s" : ""}
            </p>
          </div>
        </div>

        {/* Warning badge */}
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200/60 text-amber-700 text-[10px] font-medium">
          <AlertTriangle className="w-3 h-3" />
          Appliqué au prochain cycle
        </div>
      </div>

      {/* ═══ CATEGORY TABS (horizontal, scrollable) ═══ */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide pb-0.5 border-b border-slate-200">
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const count = CONFIG_ITEMS.filter((i) => i.category === cat.id).length;
          const isActive = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 -mb-px transition-all ${
                isActive
                  ? `border-current ${cat.color} ${cat.bg}`
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50"
              } rounded-t-md`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{cat.label}</span>
              <span className="sm:hidden">{cat.shortLabel}</span>
              <span className={`text-[10px] font-bold ${isActive ? "opacity-70" : "text-slate-400"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* ═══ CONFIG ITEMS GRID ═══ */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        {/* Category sub-header */}
        <div className={`px-4 py-2.5 border-b ${activeCat.border} ${activeCat.bg} flex items-center gap-2`}>
          <activeCat.icon className={`w-3.5 h-3.5 ${activeCat.color}`} />
          <span className={`text-xs font-semibold ${activeCat.color}`}>{activeCat.label}</span>
          <span className="text-[10px] text-slate-400 ml-auto">{activeItems.length} paramètre{activeItems.length > 1 ? "s" : ""}</span>
        </div>

        {/* Items */}
        <div className="divide-y divide-slate-50">
          {activeItems.map((item) => (
            <ConfigRow
              key={item.key}
              item={item}
              value={getValue(item.key, item.defaultValue)}
              saving={saving === item.key}
              saved={saved === item.key}
              onToggle={() => handleToggle(item)}
              onChange={(val) => setLocalValues((prev) => ({ ...prev, [item.key]: val }))}
              onSave={(val) => handleSave(item.key, val)}
            />
          ))}
        </div>
      </div>

      {/* ═══ RAW CONFIG (collapsible) ═══ */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <button
          onClick={() => setShowRaw((v) => !v)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 transition-colors"
        >
          <Terminal className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs font-semibold text-slate-600">Raw Config</span>
          <span className="text-[10px] text-slate-400">{allConfigs.length} clés</span>
          <div className="ml-auto">
            {showRaw ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
          </div>
        </button>
        {showRaw && (
          <div className="px-4 pb-3 bg-slate-900 text-[11px] font-mono overflow-x-auto max-h-40 overflow-y-auto">
            {allConfigs.length === 0 ? (
              <p className="text-slate-500 py-2">Aucune configuration enregistrée</p>
            ) : (
              allConfigs.map((row: any) => (
                <div key={row._id} className="py-0.5 flex gap-2">
                  <span className="text-emerald-400 shrink-0">{row.key}</span>
                  <span className="text-slate-600">=</span>
                  <span className="text-amber-300 truncate">{row.value}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ConfigRow — Single config item (responsive)
   ═══════════════════════════════════════════════════════════════════════════════ */
function ConfigRow({
  item,
  value,
  saving,
  saved,
  onToggle,
  onChange,
  onSave,
}: {
  item: ConfigItem;
  value: string;
  saving: boolean;
  saved: boolean;
  onToggle: () => void;
  onChange: (val: string) => void;
  onSave: (val: string) => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 gap-3 hover:bg-slate-50/50 transition-colors">
      {/* Left: label + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-800 truncate">{item.label}</span>
          {saving && <Loader2 className="w-3 h-3 animate-spin text-blue-500 shrink-0" />}
          {saved && <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />}
        </div>
        <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">{item.description}</p>
      </div>

      {/* Right: control */}
      <div className="shrink-0 flex items-center gap-1.5">
        {item.type === "toggle" && (
          <button
            onClick={onToggle}
            disabled={saving}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              value === "1" ? "bg-emerald-500" : "bg-slate-300"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                value === "1" ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        )}

        {item.type === "number" && (
          <>
            <input
              type="number"
              value={value}
              min={item.min}
              max={item.max}
              step={item.defaultValue.includes(".") ? "0.1" : "1"}
              onChange={(e) => onChange(e.target.value)}
              className="w-20 px-2 py-1 text-xs border border-slate-200 rounded-md text-right font-mono bg-slate-50 focus:bg-white focus:ring-1 focus:ring-blue-200 focus:border-blue-300 outline-none"
            />
            {item.unit && <span className="text-[10px] text-slate-400 w-5">{item.unit}</span>}
            <button
              onClick={() => onSave(value)}
              disabled={saving}
              className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
            </button>
          </>
        )}

        {item.type === "select" && (
          <select
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              onSave(e.target.value);
            }}
            className="px-2 py-1 text-xs border border-slate-200 rounded-md bg-slate-50 focus:bg-white focus:ring-1 focus:ring-blue-200 outline-none max-w-[160px]"
          >
            {item.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}

        {item.type === "text" && (
          <>
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="—"
              className="w-32 lg:w-40 px-2 py-1 text-xs border border-slate-200 rounded-md font-mono bg-slate-50 focus:bg-white focus:ring-1 focus:ring-blue-200 outline-none"
            />
            <button
              onClick={() => onSave(value)}
              disabled={saving}
              className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
