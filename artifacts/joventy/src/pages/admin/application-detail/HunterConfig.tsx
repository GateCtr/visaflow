/**
 * HunterConfig — Configuration Joventy Hunter (portail + V3 stratégie).
 * Formulaire complet avec credentials, CAPTCHA, proxy, dates, mode reporter, V3 fields.
 */
import { useState, useEffect } from "react";
import { useMutation, useAction } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Bot, Play, Pause, Trash2, Eye, Loader2, Link, RotateCcw } from "lucide-react";
import { formatDate } from "@/lib/format";

interface HunterConfigData {
  embassyUsername: string;
  embassyPassword: string;
  isActive: boolean;
  twoCaptchaApiKey?: string;
  slotDateFrom?: string;
  slotDateDeadline?: string;
  vowintAppId?: string;
  cevCountry?: string;
  scheduleUrl?: string;
  rescheduleMode?: boolean;
  rescheduleExistingDate?: string;
  useResidentialProxy?: boolean;
  lastCheckAt?: number;
  checkCount?: number;
  lastResult?: string;
  // V3
  accountRole?: string;
  currentAppointmentDate?: string;
  maxLoginsPerDay?: number;
  rushWindows?: string;
  blindBookingEnabled?: boolean;
  slotPriorityDates?: string;
  maxMonthsToScan?: number;
  nightModeEnabled?: boolean;
  preferredProxy?: string;
}

interface Props {
  appId: Id<"applications">;
  hunterConfig: HunterConfigData | null;
  destination: string;
}

export function HunterConfig({ appId, hunterConfig: hc, destination }: Props) {
  const { toast } = useToast();
  const setHunterConfig = useMutation(api.hunter.setHunterConfig);
  const resetHunterConfig = useMutation(api.hunter.resetHunterConfig);
  const setBotConfig = useMutation(api.hunter.setBotConfig);
  const checkCaptchaBalance = useAction(api.hunter.checkTwoCaptchaBalance);

  // ── State ──
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [twoCaptchaKey, setTwoCaptchaKey] = useState("");
  const [slotDateFrom, setSlotDateFrom] = useState("");
  const [slotDateDeadline, setSlotDateDeadline] = useState("");
  const [vowintAppId, setVowintAppId] = useState("");
  const [cevCountry, setCevCountry] = useState("");
  const [scheduleUrl, setScheduleUrl] = useState("");
  const [rescheduleMode, setRescheduleMode] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [useProxy, setUseProxy] = useState(false);
  const [active, setActive] = useState(false);
  // V3
  const [accountRole, setAccountRole] = useState<"eclaireur" | "confine" | "hybride">("hybride");
  const [currentApptDate, setCurrentApptDate] = useState("");
  const [maxLogins, setMaxLogins] = useState("9");
  const [rushWindows, setRushWindows] = useState("");
  const [blindBooking, setBlindBooking] = useState(false);
  const [priorityDates, setPriorityDates] = useState("");
  const [maxMonths, setMaxMonths] = useState("3");
  const [nightMode, setNightMode] = useState(true);
  const [preferredProxy, setPreferredProxy] = useState("");
  // UI
  const [saving, setSaving] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [captchaBalance, setCaptchaBalance] = useState<number | null>(null);
  const [captchaChecking, setCaptchaChecking] = useState(false);
  const [resettingBudget, setResettingBudget] = useState(false);

  // Hydrate from config
  useEffect(() => {
    if (hc) {
      setUsername(hc.embassyUsername ?? "");
      setPassword(hc.embassyPassword ?? "");
      setActive(hc.isActive ?? false);
      setTwoCaptchaKey(hc.twoCaptchaApiKey ?? "");
      setSlotDateFrom(hc.slotDateFrom ?? "");
      setSlotDateDeadline(hc.slotDateDeadline ?? "");
      setVowintAppId(hc.vowintAppId ?? "");
      setCevCountry(hc.cevCountry ?? "");
      setScheduleUrl(hc.scheduleUrl ?? "");
      setRescheduleMode(hc.rescheduleMode ?? false);
      setRescheduleDate(hc.rescheduleExistingDate ?? "");
      setUseProxy(hc.useResidentialProxy ?? false);
      setAccountRole((hc.accountRole as "eclaireur" | "confine" | "hybride") ?? "hybride");
      setCurrentApptDate(hc.currentAppointmentDate ?? "");
      setMaxLogins(String(hc.maxLoginsPerDay ?? 9));
      setRushWindows(hc.rushWindows ?? "");
      setBlindBooking(hc.blindBookingEnabled ?? false);
      setPriorityDates(Array.isArray(hc.slotPriorityDates) ? hc.slotPriorityDates.join(", ") : (hc.slotPriorityDates ?? ""));
      setMaxMonths(String(hc.maxMonthsToScan ?? 3));
      setNightMode(hc.nightModeEnabled ?? true);
      setPreferredProxy(hc.preferredProxy ?? "");
    }
  }, [hc]);

  const handleSave = async () => {
    if (!username.trim() || !password.trim()) { toast({ variant: "destructive", title: "Identifiant et mot de passe requis" }); return; }
    setSaving(true);
    try {
      await setHunterConfig({
        applicationId: appId, embassyUsername: username, embassyPassword: password, isActive: active,
        twoCaptchaApiKey: twoCaptchaKey || undefined, slotDateFrom: slotDateFrom || undefined, slotDateDeadline: slotDateDeadline || undefined,
        vowintAppId: vowintAppId || undefined, cevCountry: cevCountry || undefined, scheduleUrl: scheduleUrl || undefined,
        rescheduleMode: rescheduleMode || undefined, rescheduleExistingDate: rescheduleDate || undefined, useResidentialProxy: useProxy || undefined,
        accountRole: accountRole || undefined, currentAppointmentDate: currentApptDate || undefined,
        maxLoginsPerDay: maxLogins ? Number(maxLogins) : undefined, rushWindows: rushWindows || undefined,
        blindBookingEnabled: blindBooking || undefined, slotPriorityDates: priorityDates || undefined,
        maxMonthsToScan: maxMonths ? Number(maxMonths) : undefined, nightModeEnabled: nightMode, preferredProxy: preferredProxy || undefined,
      });
      toast({ title: "Hunter sauvegardé", description: active ? "Robot actif." : "Robot en pause." });
    } catch (err: unknown) { toast({ variant: "destructive", title: "Erreur", description: err instanceof Error ? err.message : "Échec" }); }
    finally { setSaving(false); }
  };

  const handleReset = async () => {
    setSaving(true);
    try { await resetHunterConfig({ applicationId: appId }); toast({ title: "Config effacée" }); }
    catch (err: unknown) { toast({ variant: "destructive", title: err instanceof Error ? err.message : "Erreur" }); }
    finally { setSaving(false); }
  };

  const handleResetBudget = async () => {
    if (!username.trim()) { toast({ variant: "destructive", title: "Identifiant requis pour reset budget" }); return; }
    setResettingBudget(true);
    try {
      await setBotConfig({ key: `reset_budget:${username.trim()}`, value: "7" });
      toast({ title: "Reset budget demandé", description: `Le bot remettra le budget à 7 pour ${username.trim()} au prochain tick.` });
    } catch (err: unknown) { toast({ variant: "destructive", title: "Erreur", description: err instanceof Error ? err.message : "Échec" }); }
    finally { setResettingBudget(false); }
  };

  const lastResultLabel: Record<string, string> = { not_found: "Aucun créneau", captcha: "CAPTCHA", error: "Erreur", slot_captured: "Capturé!", payment_required: "Paiement requis" };

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-purple-100 bg-gradient-to-r from-purple-50 to-indigo-50/50 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">
          <Bot className="w-4 h-4 text-white" />
        </div>
        <div className="flex-1">
          <h2 className="font-semibold text-purple-900 text-sm">Joventy Hunter</h2>
          <p className="text-[11px] text-purple-600/70">Configuration du robot de recherche</p>
        </div>
        <span className={`text-[11px] px-2.5 py-1 rounded-full font-semibold ${hc?.isActive ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
          {hc?.isActive ? "Actif" : hc ? "Pause" : "Non configuré"}
        </span>
      </div>

      <div className="p-6 space-y-5">
        {/* Credentials */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Identifiant portail">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="email@exemple.com" className="h-9 bg-slate-50/80 text-sm" />
          </Field>
          <Field label="Mot de passe">
            <div className="relative">
              <Input type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="h-9 bg-slate-50/80 text-sm pr-9" />
              <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => setShowPw(v => !v)}>
                <Eye className="w-3.5 h-3.5" />
              </button>
            </div>
          </Field>
        </div>

        {/* 2captcha */}
        <Field label="Clé 2captcha">
          <div className="flex gap-2">
            <Input value={twoCaptchaKey} onChange={(e) => { setTwoCaptchaKey(e.target.value); setCaptchaBalance(null); }} placeholder="Optionnel" className="h-9 bg-slate-50/80 text-sm font-mono flex-1" />
            <Button size="sm" variant="outline" className="h-9 text-xs" disabled={captchaChecking}
              onClick={async () => { setCaptchaChecking(true); try { const r = await checkCaptchaBalance({ applicationId: appId }); setCaptchaBalance(r.balance); } catch {} finally { setCaptchaChecking(false); } }}>
              {captchaChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : "Solde"}
            </Button>
          </div>
          {captchaBalance !== null && <p className={`text-xs mt-1 font-medium ${captchaBalance >= 5 ? "text-emerald-600" : captchaBalance >= 1 ? "text-amber-600" : "text-red-600"}`}>${captchaBalance.toFixed(2)}</p>}
        </Field>

        {/* Date range */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Date minimum"><Input type="date" value={slotDateFrom} onChange={(e) => setSlotDateFrom(e.target.value)} className="h-9 bg-slate-50/80 text-sm" /></Field>
          <Field label="Date limite"><Input type="date" value={slotDateDeadline} onChange={(e) => setSlotDateDeadline(e.target.value)} className="h-9 bg-slate-50/80 text-sm" /></Field>
        </div>

        {/* Destination-specific */}
        {destination === "schengen" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-indigo-50/50 rounded-xl border border-indigo-100/80">
            <Field label="URL VOWINT"><Input value={vowintAppId} onChange={(e) => setVowintAppId(e.target.value)} placeholder="https://visaonweb..." className="h-9 bg-white text-sm font-mono" /></Field>
            <Field label="Pays Schengen"><Input value={cevCountry} onChange={(e) => setCevCountry(e.target.value)} placeholder="France, Belgique..." className="h-9 bg-white text-sm" /></Field>
          </div>
        )}
        {destination === "spain" && (
          <Field label="URL Bookitit"><Input value={scheduleUrl} onChange={(e) => setScheduleUrl(e.target.value)} placeholder="https://www.citaconsular.es/..." className="h-9 bg-slate-50/80 text-sm font-mono" /></Field>
        )}
        {destination === "usa" && (
          <>
            <Toggle label="Proxy résidentiel (USA)" checked={useProxy} onChange={setUseProxy} />
            <Toggle label="Mode Reporter (Reschedule)" checked={rescheduleMode} onChange={setRescheduleMode} />
            {rescheduleMode && <Field label="Date RDV existant"><Input type="date" value={rescheduleDate} onChange={(e) => setRescheduleDate(e.target.value)} className="h-9 bg-slate-50/80 text-sm" /></Field>}
          </>
        )}

        {/* V3 Strategy */}
        <div className="p-4 bg-indigo-50/40 rounded-xl border border-indigo-100/60 space-y-3">
          <p className="text-[11px] text-indigo-700 uppercase font-bold tracking-wide">V3 Stratégie Multi-Compte</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label="Rôle">
              <select value={accountRole} onChange={(e) => setAccountRole(e.target.value as any)} className="w-full h-9 px-2 text-sm border rounded-md bg-white border-slate-200">
                <option value="hybride">Hybride</option>
                <option value="eclaireur">Éclaireur</option>
                <option value="confine">Confiné</option>
              </select>
            </Field>
            <Field label="Date RDV actuel"><Input type="date" value={currentApptDate} onChange={(e) => setCurrentApptDate(e.target.value)} className="h-9 bg-white text-sm" /></Field>
            <Field label="Logins/jour"><Input type="number" min={1} max={10} value={maxLogins} onChange={(e) => setMaxLogins(e.target.value)} className="h-9 bg-white text-sm font-mono" /></Field>
            <Field label="Mois à scanner"><Input type="number" min={1} max={12} value={maxMonths} onChange={(e) => setMaxMonths(e.target.value)} className="h-9 bg-white text-sm font-mono" /></Field>
            <Field label="Dates prioritaires"><Input value={priorityDates} onChange={(e) => setPriorityDates(e.target.value)} placeholder="2026-09-*,2026-10-15" className="h-9 bg-white text-sm font-mono" /></Field>
            <Field label="Proxy préféré">
              <select value={preferredProxy} onChange={(e) => setPreferredProxy(e.target.value)} className="w-full h-9 px-2 text-sm border rounded-md bg-white border-slate-200">
                <option value="">Défaut</option>
                <option value="iproyal">iProyal</option>
                <option value="brightdata">BrightData</option>
                <option value="2captcha">2captcha</option>
              </select>
            </Field>
          </div>
          <Field label="Rush windows (JSON)"><Input value={rushWindows} onChange={(e) => setRushWindows(e.target.value)} placeholder='[{"start":0,"end":2}]' className="h-9 bg-white text-sm font-mono" /></Field>
          <div className="flex flex-wrap gap-4 pt-1">
            <Toggle label="Blind Booking" checked={blindBooking} onChange={setBlindBooking} compact />
            <Toggle label="Mode Nuit" checked={nightMode} onChange={setNightMode} compact />
          </div>
        </div>

        {/* Active toggle + actions */}
        <div className="flex items-center gap-3 pt-2">
          <button type="button" onClick={() => setActive(v => !v)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${active ? "bg-purple-600" : "bg-slate-300"}`}>
            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${active ? "translate-x-6" : "translate-x-1"}`} />
          </button>
          <span className="text-sm font-medium text-slate-700">{active ? "Surveillance active" : "En pause"}</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={handleSave} disabled={saving} className="h-9 gap-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium shadow-sm">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : active ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            {saving ? "..." : "Sauvegarder"}
          </Button>
          {hc && (
            <Button variant="outline" onClick={handleReset} disabled={saving} className="h-9 gap-2 text-sm border-red-200 text-red-600 hover:bg-red-50">
              <Trash2 className="w-3.5 h-3.5" /> Effacer
            </Button>
          )}
          {destination === "usa" && hc && (
            <Button variant="outline" onClick={handleResetBudget} disabled={resettingBudget || !username.trim()} className="h-9 gap-2 text-sm border-amber-200 text-amber-700 hover:bg-amber-50">
              {resettingBudget ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Reset budget login
            </Button>
          )}
        </div>

        {/* Last check info */}
        {hc && (
          <div className="grid grid-cols-3 gap-3 p-3 bg-slate-50/80 rounded-xl border border-slate-100 text-center">
            <div><p className="text-[10px] text-slate-400 uppercase">Dernier</p><p className="text-xs font-medium text-slate-700">{hc.lastCheckAt ? formatDate(hc.lastCheckAt) : "—"}</p></div>
            <div><p className="text-[10px] text-slate-400 uppercase">Résultat</p><p className="text-xs font-medium text-slate-700">{hc.lastResult ? (lastResultLabel[hc.lastResult] ?? hc.lastResult) : "—"}</p></div>
            <div><p className="text-[10px] text-slate-400 uppercase">Tentatives</p><p className="text-xs font-bold text-purple-700">{hc.checkCount ?? 0}</p></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-slate-500 uppercase font-semibold tracking-wide">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange, compact }: { label: string; checked: boolean; onChange: (v: boolean) => void; compact?: boolean }) {
  return (
    <div className={`flex items-center gap-2 ${compact ? "" : "py-1"}`}>
      <button type="button" onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? "bg-indigo-500" : "bg-slate-300"}`}>
        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
      </button>
      <span className="text-xs text-slate-700 font-medium">{label}</span>
    </div>
  );
}
