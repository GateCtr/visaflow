import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  Settings,
  Zap,
  Clock,
  Shield,
  Server,
  Moon,
  RefreshCw,
  Save,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";

// ─── Configuration keys et leurs descriptions ────────────────────────────────

interface ConfigItem {
  key: string;
  label: string;
  description: string;
  type: "toggle" | "number" | "text" | "select";
  category: "mode" | "timing" | "protection" | "proxy" | "prediction";
  defaultValue: string;
  options?: { value: string; label: string }[];
  unit?: string;
  min?: number;
  max?: number;
}

const CONFIG_ITEMS: ConfigItem[] = [
  // ─── Mode d'execution ──────────────────────────────────────────────────
  {
    key: "parallel_watcher_mode",
    label: "Mode Parallele (Watcher OFC)",
    description: "Active le watcher partage + booking race. 1 refresh/45s pour tous les dossiers Kinshasa au lieu du mode sequentiel (1 dossier/42min).",
    type: "toggle",
    category: "mode",
    defaultValue: "0",
  },
  // ─── Timing / Intervalles ──────────────────────────────────────────────
  {
    key: "watcher_base_interval_ms",
    label: "Intervalle Watcher (ms)",
    description: "Intervalle de base entre deux refreshes du watcher OFC. Adapte automatiquement selon prediction + latence.",
    type: "number",
    category: "timing",
    defaultValue: "45000",
    unit: "ms",
    min: 15000,
    max: 180000,
  },
  {
    key: "rush_interval_min_ms",
    label: "Intervalle Rush Min (ms)",
    description: "Intervalle minimum pendant les rush hours (00-02h, 07-09h, 12-14h Kinshasa).",
    type: "number",
    category: "timing",
    defaultValue: "300000",
    unit: "ms",
    min: 60000,
    max: 600000,
  },
  {
    key: "rush_interval_max_ms",
    label: "Intervalle Rush Max (ms)",
    description: "Intervalle maximum pendant les rush hours.",
    type: "number",
    category: "timing",
    defaultValue: "420000",
    unit: "ms",
    min: 120000,
    max: 900000,
  },
  // ─── Protection / Anti-detection ───────────────────────────────────────
  {
    key: "scan_cap_min",
    label: "Cap Scans Min / Session",
    description: "Nombre minimum de scans avant arret force de session (simule un humain fatigue).",
    type: "number",
    category: "protection",
    defaultValue: "6",
    min: 3,
    max: 20,
  },
  {
    key: "scan_cap_max",
    label: "Cap Scans Max / Session",
    description: "Nombre maximum de scans par session avant pause forcee.",
    type: "number",
    category: "protection",
    defaultValue: "10",
    min: 5,
    max: 30,
  },
  {
    key: "cooldown_min_ms",
    label: "Cooldown Min apres expiry (ms)",
    description: "Temps minimum d'attente apres expiration du JWT avant re-login.",
    type: "number",
    category: "protection",
    defaultValue: "480000",
    unit: "ms",
    min: 120000,
    max: 1800000,
  },
  {
    key: "cooldown_max_ms",
    label: "Cooldown Max apres expiry (ms)",
    description: "Temps maximum d'attente apres expiration du JWT avant re-login.",
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
    description: "Active la pause nocturne (02h30-06h30 variable par compte). Desactiver pour scanner 24/24.",
    type: "toggle",
    category: "protection",
    defaultValue: "1",
  },
  // ─── Prediction Early Bird ─────────────────────────────────────────────
  {
    key: "prediction_min_observations",
    label: "Observations Min (Prediction)",
    description: "Nombre minimum de slots detectes avant que la prediction Early Bird s'active.",
    type: "number",
    category: "prediction",
    defaultValue: "1",
    min: 1,
    max: 10,
  },
  {
    key: "prediction_hot_threshold",
    label: "Seuil Hot Window",
    description: "Score minimum (0-1) pour considerer une tranche horaire comme 'chaude' (refresh accelere).",
    type: "number",
    category: "prediction",
    defaultValue: "0.4",
    min: 0.1,
    max: 0.9,
  },
  {
    key: "prediction_history_days",
    label: "Historique Prediction (jours)",
    description: "Nombre de jours d'historique utilises pour la prediction des fenetres de liberation.",
    type: "number",
    category: "prediction",
    defaultValue: "7",
    min: 1,
    max: 30,
  },
  // ─── Proxy ─────────────────────────────────────────────────────────────
  {
    key: "proxy_provider_priority",
    label: "Priorite Proxy",
    description: "Ordre de preference des providers proxy pour les nouveaux comptes.",
    type: "select",
    category: "proxy",
    defaultValue: "iproyal",
    options: [
      { value: "iproyal", label: "iProyal > BrightData > 2captcha" },
      { value: "brightdata", label: "BrightData > iProyal > 2captcha" },
      { value: "2captcha", label: "2captcha uniquement" },
    ],
  },
  {
    key: "proxy_sticky_lifetime_h",
    label: "Duree Sticky Proxy (heures)",
    description: "Duree de vie du proxy sticky iProyal. Apres expiration, nouvelle IP au prochain login.",
    type: "number",
    category: "proxy",
    defaultValue: "12",
    unit: "h",
    min: 1,
    max: 24,
  },
];

// ─── Regroupement par categorie ──────────────────────────────────────────────

const CATEGORIES = [
  { id: "mode", label: "Mode d'Execution", icon: Zap, color: "text-amber-600" },
  { id: "timing", label: "Intervalles & Timing", icon: Clock, color: "text-blue-600" },
  { id: "protection", label: "Anti-Detection & Securite", icon: Shield, color: "text-red-600" },
  { id: "prediction", label: "Prediction Early Bird", icon: RefreshCw, color: "text-purple-600" },
  { id: "proxy", label: "Proxy & Reseau", icon: Server, color: "text-green-600" },
] as const;

// ─── Composant Principal ─────────────────────────────────────────────────────

export default function BotSettings() {
  const allConfigs = useQuery(api.hunter.listBotConfig);
  const setBotConfig = useMutation(api.hunter.setBotConfig);
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Initialiser les valeurs locales depuis Convex
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
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">Chargement configuration...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-slate-100 rounded-lg">
          <Settings className="w-6 h-6 text-slate-700" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Configuration Hunter Bot</h1>
          <p className="text-sm text-muted-foreground">
            Parametres du bot de recherche de creneaux. Les changements prennent effet au prochain redemarrage.
          </p>
        </div>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg">
        <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
        <div className="text-sm text-amber-800">
          <p className="font-medium">Note importante</p>
          <p className="mt-1">
            Les modifications sont sauvegardees immediatement dans Convex. Le bot les appliquera
            au prochain cycle de demarrage (redemarrage Railway ou cycle naturel).
            Le mode parallele s'active au boot uniquement.
          </p>
        </div>
      </div>

      {/* Categories */}
      {CATEGORIES.map((cat) => {
        const items = CONFIG_ITEMS.filter((i) => i.category === cat.id);
        if (items.length === 0) return null;

        const Icon = cat.icon;

        return (
          <div key={cat.id} className="border rounded-lg overflow-hidden">
            {/* Category header */}
            <div className="flex items-center gap-2 px-5 py-3 bg-slate-50 border-b">
              <Icon className={`w-4 h-4 ${cat.color}`} />
              <h2 className="font-semibold text-slate-800">{cat.label}</h2>
            </div>

            {/* Items */}
            <div className="divide-y">
              {items.map((item) => (
                <div key={item.key} className="flex items-center justify-between px-5 py-4 gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-slate-900">{item.label}</span>
                      {saving === item.key && (
                        <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                      )}
                      {saved === item.key && (
                        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {item.description}
                    </p>
                    <p className="text-[10px] text-slate-400 mt-0.5 font-mono">
                      key: {item.key}
                    </p>
                  </div>

                  <div className="shrink-0">
                    {item.type === "toggle" && (
                      <button
                        onClick={() => handleToggle(item)}
                        className="focus:outline-none"
                        disabled={saving === item.key}
                      >
                        {getValue(item.key, item.defaultValue) === "1" ? (
                          <ToggleRight className="w-10 h-10 text-emerald-500" />
                        ) : (
                          <ToggleLeft className="w-10 h-10 text-slate-300" />
                        )}
                      </button>
                    )}

                    {item.type === "number" && (
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={getValue(item.key, item.defaultValue)}
                          min={item.min}
                          max={item.max}
                          step={item.defaultValue.includes(".") ? "0.1" : "1"}
                          onChange={(e) =>
                            setLocalValues((prev) => ({ ...prev, [item.key]: e.target.value }))
                          }
                          className="w-28 px-2 py-1.5 text-sm border rounded-md text-right font-mono focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none"
                        />
                        {item.unit && (
                          <span className="text-xs text-muted-foreground w-6">{item.unit}</span>
                        )}
                        <button
                          onClick={() => handleSave(item.key, getValue(item.key, item.defaultValue))}
                          disabled={saving === item.key}
                          className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                          title="Sauvegarder"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                      </div>
                    )}

                    {item.type === "select" && (
                      <div className="flex items-center gap-2">
                        <select
                          value={getValue(item.key, item.defaultValue)}
                          onChange={(e) => {
                            setLocalValues((prev) => ({ ...prev, [item.key]: e.target.value }));
                            handleSave(item.key, e.target.value);
                          }}
                          className="px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none"
                        >
                          {item.options?.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {item.type === "text" && (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={getValue(item.key, item.defaultValue)}
                          onChange={(e) =>
                            setLocalValues((prev) => ({ ...prev, [item.key]: e.target.value }))
                          }
                          className="w-40 px-2 py-1.5 text-sm border rounded-md font-mono focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none"
                        />
                        <button
                          onClick={() => handleSave(item.key, getValue(item.key, item.defaultValue))}
                          disabled={saving === item.key}
                          className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                          title="Sauvegarder"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Raw config viewer */}
      <div className="border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 bg-slate-50 border-b">
          <Moon className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold text-slate-800">Toutes les cles (raw)</h2>
        </div>
        <div className="p-4 bg-slate-900 text-slate-100 text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto">
          {allConfigs.length === 0 ? (
            <p className="text-slate-400">Aucune configuration enregistree</p>
          ) : (
            allConfigs.map((row) => (
              <div key={row._id} className="py-0.5">
                <span className="text-emerald-400">{row.key}</span>
                <span className="text-slate-500"> = </span>
                <span className="text-amber-300">{row.value.length > 60 ? row.value.slice(0, 60) + "..." : row.value}</span>
                <span className="text-slate-600 ml-2">
                  ({new Date(row.updatedAt).toLocaleString("fr-CD")})
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
