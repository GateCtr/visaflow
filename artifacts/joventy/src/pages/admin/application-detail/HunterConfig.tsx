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
  portalApplicationId?: string;
  applicantFirstname?: string;
  applicantLastname?: string;
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
  // CEV Dossier Loop v3 - Multi-comptes
  cevDossierPool?: string;
  cevUseProxy?: boolean;
  cevScanIntervalSec?: number;
}

interface Props {
  appId: Id<"applications">;
  hunterConfig: HunterConfigData | null;
  destination: string;
  /** Classe de visa normalisée actuelle (depuis l'application). */
  broadcastVisaClass?: string | null;
  /** Code visa US (ex: "F1", "B1/B2"). */
  usVisaCode?: string | null;
  /** Catégorie macro (NIV ou IV). */
  usVisaCategory?: string | null;
}

export function HunterConfig({ appId, hunterConfig: hc, destination, broadcastVisaClass, usVisaCode, usVisaCategory }: Props) {
  const { toast } = useToast();
  const setHunterConfig = useMutation(api.hunter.setHunterConfig);
  const resetHunterConfig = useMutation(api.hunter.resetHunterConfig);
  const setBotConfig = useMutation(api.hunter.setBotConfig);
  const checkTwoCaptchaBalance = useAction(api.hunter.checkTwoCaptchaBalance);
  const checkCapsolverBalance = useAction(api.hunter.checkCapsolverBalanceRaw);
  const checkAntiCaptchaBalance = useAction(api.hunter.checkAntiCaptchaBalanceRaw);
  const assignVisaClass = useMutation(api.applications.assignVisaClass);

  // ── State ──
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [captchaKey, setCaptchaKey] = useState("");
  const [slotDateFrom, setSlotDateFrom] = useState("");
  const [slotDateDeadline, setSlotDateDeadline] = useState("");
  const [vowintAppId, setVowintAppId] = useState("");
  const [scheduleUrl, setScheduleUrl] = useState("");
  const [portalApplicationId, setPortalApplicationId] = useState("");
  const [applicantFirstname, setApplicantFirstname] = useState("");
  const [applicantLastname, setApplicantLastname] = useState("");
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
  // CEV Dossier Loop v3 - Multi-comptes
  const [cevDossierPool, setCevDossierPool] = useState("");
  const [cevUseProxy, setCevUseProxy] = useState(false);
  const [cevScanIntervalSec, setCevScanIntervalSec] = useState("225");
  // Visa Class (meute)
  const [visaClassInput, setVisaClassInput] = useState(broadcastVisaClass ?? "");
  const [savingVisaClass, setSavingVisaClass] = useState(false);
  // UI
  const [saving, setSaving] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [captchaBalance, setCaptchaBalance] = useState<number | null>(null);
  const [captchaChecking, setCaptchaChecking] = useState(false);
  const [resettingBudget, setResettingBudget] = useState(false);
  const [resetBudgetValue, setResetBudgetValue] = useState("7");

  // Hydrate from config
  useEffect(() => {
    if (hc) {
      setUsername(hc.embassyUsername ?? "");
      setPassword(hc.embassyPassword ?? "");
      setActive(hc.isActive ?? false);
      setCaptchaKey(hc.twoCaptchaApiKey ?? "");
      setSlotDateFrom(hc.slotDateFrom ?? "");
      setSlotDateDeadline(hc.slotDateDeadline ?? "");
      setVowintAppId(hc.vowintAppId ?? "");
      setScheduleUrl(hc.scheduleUrl ?? "");
      setPortalApplicationId(hc.portalApplicationId ?? "");
      setApplicantFirstname(hc.applicantFirstname ?? "");
      setApplicantLastname(hc.applicantLastname ?? "");
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
      // CEV Dossier Loop v3 - Multi-comptes
      setCevDossierPool(hc.cevDossierPool ?? "");
      setCevUseProxy(hc.cevUseProxy ?? false);
      setCevScanIntervalSec(String(hc.cevScanIntervalSec ?? 225));
    }
  }, [hc]);

  // Sync visa class from prop separately — broadcastVisaClass lives on the
  // application document (NOT inside hunterConfig), so it must not be driven
  // by [hc] which would use a stale closure value after setHunterConfig saves.
  useEffect(() => {
    setVisaClassInput(broadcastVisaClass ?? "");
  }, [broadcastVisaClass]);

  const handleSave = async () => {
    const isGermany = destination === "germany";
    if (!username.trim()) { toast({ variant: "destructive", title: "Identifiant requis" }); return; }
    if (!isGermany && !password.trim()) { toast({ variant: "destructive", title: "Identifiant et mot de passe requis" }); return; }
    setSaving(true);
    try {
      await setHunterConfig({
        applicationId: appId, embassyUsername: username, embassyPassword: password.trim() || "N/A", isActive: active,
        twoCaptchaApiKey: captchaKey || undefined, slotDateFrom: slotDateFrom || undefined, slotDateDeadline: slotDateDeadline || undefined,
        vowintAppId: vowintAppId || undefined, scheduleUrl: scheduleUrl || undefined,
        portalApplicationId: portalApplicationId || undefined,
        applicantFirstname: applicantFirstname || undefined,
        applicantLastname: applicantLastname || undefined,
        rescheduleMode: rescheduleMode, rescheduleExistingDate: rescheduleDate || undefined, useResidentialProxy: useProxy,
        accountRole: accountRole || undefined, currentAppointmentDate: currentApptDate || undefined,
        maxLoginsPerDay: maxLogins ? Number(maxLogins) : undefined, rushWindows: rushWindows || undefined,
        blindBookingEnabled: blindBooking, slotPriorityDates: priorityDates || undefined,
        maxMonthsToScan: maxMonths ? Number(maxMonths) : undefined, nightModeEnabled: nightMode, preferredProxy: preferredProxy || undefined,
        // CEV Dossier Loop v3 - Multi-comptes
        cevDossierPool: cevDossierPool || undefined, cevUseProxy: cevUseProxy,
        cevScanIntervalSec: cevScanIntervalSec ? Number(cevScanIntervalSec) : undefined,
      });
      // Sauvegarder aussi le canal visa si modifié (destination USA uniquement)
      if (destination === "usa" && visaClassInput && visaClassInput !== (broadcastVisaClass ?? "")) {
        const category = ["IR", "CR", "DV", "EB", "F2A", "F2B", "F1-IV", "F3-IV", "F4-IV", "SB1", "SE", "SQ"].includes(visaClassInput) ? "IV" : "NIV";
        await assignVisaClass({
          applicationId: appId,
          broadcastVisaClass: visaClassInput,
          usVisaCategory: category as "NIV" | "IV",
          usVisaCode: visaClassInput,
        });
      }
      // Activer le mode dossier CEV si on configure un pool de dossiers Schengen
      if (destination === "schengen" && cevDossierPool && cevDossierPool.trim()) {
        await setBotConfig({ key: "cev_dossier_mode", value: "1" });
      }
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
    const val = parseInt(resetBudgetValue, 10);
    if (!val || val < 1 || val > 10) { toast({ variant: "destructive", title: "Valeur entre 1 et 10 requise" }); return; }
    setResettingBudget(true);
    try {
      await setBotConfig({ key: `reset_budget:${username.trim()}`, value: String(val) });
      toast({ title: "Reset budget demandé", description: `Le bot remettra le budget à ${val} pour ${username.trim()} au prochain tick.` });
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
          <Field label={destination === "germany" ? "Email applicant (RK-Termin)" : "Identifiant portail"}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="email@exemple.com" className="h-9 bg-slate-50/80 text-sm" />
          </Field>
          <Field label={destination === "germany" ? "Mot de passe (non utilisé)" : "Mot de passe"}>
            <div className="relative">
              <Input type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="h-9 bg-slate-50/80 text-sm pr-9" />
              <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => setShowPw(v => !v)}>
                <Eye className="w-3.5 h-3.5" />
              </button>
            </div>
          </Field>
        </div>

        {/* Captcha service - destination-specific */}
        {destination === "usa" && (
          <Field label="Clé 2captcha">
            <div className="flex gap-2">
              <Input value={captchaKey} onChange={(e) => { setCaptchaKey(e.target.value); setCaptchaBalance(null); }} placeholder="Optionnel" className="h-9 bg-slate-50/80 text-sm font-mono flex-1" />
              <Button size="sm" variant="outline" className="h-9 text-xs" disabled={captchaChecking}
                onClick={async () => { setCaptchaChecking(true); try { const r = await checkTwoCaptchaBalance({ applicationId: appId }); setCaptchaBalance(r.balance); } catch {} finally { setCaptchaChecking(false); } }}>
                {captchaChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : "Solde"}
              </Button>
            </div>
            {captchaBalance !== null && <p className={`text-xs mt-1 font-medium ${captchaBalance >= 5 ? "text-emerald-600" : captchaBalance >= 1 ? "text-amber-600" : "text-red-600"}`}>${captchaBalance.toFixed(2)}</p>}
          </Field>
        )}
        {destination === "schengen" && (
          <Field label="Clé Anti-Captcha">
            <div className="flex gap-2">
              <Input value={captchaKey} onChange={(e) => { setCaptchaKey(e.target.value); setCaptchaBalance(null); }} placeholder="Optionnel" className="h-9 bg-slate-50/80 text-sm font-mono flex-1" />
              <Button size="sm" variant="outline" className="h-9 text-xs" disabled={captchaChecking}
                onClick={async () => { setCaptchaChecking(true); try { const r = await checkAntiCaptchaBalance({ apiKey: captchaKey }); setCaptchaBalance(r.balance); } catch {} finally { setCaptchaChecking(false); } }}>
                {captchaChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : "Solde"}
              </Button>
            </div>
            {captchaBalance !== null && <p className={`text-xs mt-1 font-medium ${captchaBalance >= 5 ? "text-emerald-600" : captchaBalance >= 1 ? "text-amber-600" : "text-red-600"}`}>${captchaBalance.toFixed(2)}</p>}
          </Field>
        )}
        {destination === "spain" && (
          <Field label="Clé CapSolver">
            <div className="flex gap-2">
              <Input value={captchaKey} onChange={(e) => { setCaptchaKey(e.target.value); setCaptchaBalance(null); }} placeholder="Optionnel" className="h-9 bg-slate-50/80 text-sm font-mono flex-1" />
              <Button size="sm" variant="outline" className="h-9 text-xs" disabled={captchaChecking}
                onClick={async () => { setCaptchaChecking(true); try { const r = await checkCapsolverBalance({ apiKey: captchaKey }); setCaptchaBalance(r.balance); } catch {} finally { setCaptchaChecking(false); } }}>
                {captchaChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : "Solde"}
              </Button>
            </div>
            {captchaBalance !== null && <p className={`text-xs mt-1 font-medium ${captchaBalance >= 5 ? "text-emerald-600" : captchaBalance >= 1 ? "text-amber-600" : "text-red-600"}`}>${captchaBalance.toFixed(2)}</p>}
          </Field>
        )}

        {/* Date range */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Date minimum"><Input type="date" value={slotDateFrom} onChange={(e) => setSlotDateFrom(e.target.value)} className="h-9 bg-slate-50/80 text-sm" /></Field>
          <Field label="Date limite"><Input type="date" value={slotDateDeadline} onChange={(e) => setSlotDateDeadline(e.target.value)} className="h-9 bg-slate-50/80 text-sm" /></Field>
        </div>

        {/* Destination-specific */}
        {destination === "schengen" && (
          <div className="p-4 bg-indigo-50/40 rounded-xl border border-indigo-100/60 space-y-4">
            <p className="text-[11px] text-indigo-700 uppercase font-bold tracking-wide">Configuration CEV Schengen</p>
            <p className="text-[10px] text-slate-600">Laissez vide pour navigation automatique (premier dossier trouvé)</p>
            <div className="p-3 bg-emerald-50/50 rounded-lg border border-emerald-100/60 space-y-3">
              <Field label="Dossiers (optionnel)">
                <Input
                  value={cevDossierPool}
                  onChange={(e) => setCevDossierPool(e.target.value)}
                  placeholder="VOWINT6085888 ou VOWINT1,VOWINT2,VOWINT3 (vide = auto)"
                  className="h-9 bg-white text-sm font-mono"
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Intervalle scan (sec)">
                  <Input 
                    type="number" 
                    min={60} 
                    max={3600} 
                    value={cevScanIntervalSec} 
                    onChange={(e) => setCevScanIntervalSec(e.target.value)} 
                    placeholder="225" 
                    className="h-9 bg-white text-sm font-mono" 
                  />
                </Field>
                <div className="flex items-center gap-2 py-1">
                  <button type="button" onClick={() => setCevUseProxy(v => !v)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${cevUseProxy ? "bg-emerald-500" : "bg-slate-300"}`}>
                    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${cevUseProxy ? "translate-x-4" : "translate-x-0.5"}`} />
                  </button>
                  <span className="text-xs text-slate-700 font-medium">Proxy résidentiel</span>
                </div>
              </div>
            </div>
          </div>
        )}
        {destination === "spain" && (
          <Field label="URL Bookitit"><Input value={scheduleUrl} onChange={(e) => setScheduleUrl(e.target.value)} placeholder="https://www.citaconsular.es/..." className="h-9 bg-slate-50/80 text-sm font-mono" /></Field>
        )}
        {destination === "germany" && (
          <div className="space-y-3 p-3 bg-yellow-50/50 rounded-xl border border-yellow-100/80">
            <p className="text-[10px] text-yellow-800/80">locationCode, realmId, categoryId et locale sont dérivés automatiquement du type de visa.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Nom de famille (applicantLastname)">
                <Input value={applicantLastname} onChange={(e) => setApplicantLastname(e.target.value)} placeholder="YAGUNVU GBAFU" className="h-9 bg-white text-sm font-mono" />
              </Field>
              <Field label="Prénom (applicantFirstname)">
                <Input value={applicantFirstname} onChange={(e) => setApplicantFirstname(e.target.value)} placeholder="EGGEE" className="h-9 bg-white text-sm font-mono" />
              </Field>
              <Field label="Schedule URL (optionnel)"><Input value={scheduleUrl} onChange={(e) => setScheduleUrl(e.target.value)} placeholder="https://service2.diplo.de/rktermin/extern/..." className="h-9 bg-white text-sm font-mono" /></Field>
              <Field label="Données portail (JSON → portalApplicationId)"><Input value={portalApplicationId} onChange={(e) => setPortalApplicationId(e.target.value)} placeholder='{"nationality":"Kongolesisch","passportNumber":"OB..."}' className="h-9 bg-white text-sm font-mono" /></Field>
            </div>
          </div>
        )}
        {destination === "usa" && (
          <>
            <Toggle label="Proxy résidentiel (USA)" checked={useProxy} onChange={setUseProxy} />
            <Toggle label="Mode Reporter (Reschedule)" checked={rescheduleMode} onChange={setRescheduleMode} />
            {rescheduleMode && <Field label="Date RDV existant"><Input type="date" value={rescheduleDate} onChange={(e) => setRescheduleDate(e.target.value)} className="h-9 bg-slate-50/80 text-sm" /></Field>}
          </>
        )}

        {/* V3 Strategy (USA only) */}
        {destination === "usa" && (
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
        )}

        {/* Canal Visa — assignation meute homogène (USA uniquement) */}
        {destination === "usa" && (
          <div className="p-4 bg-amber-50/50 rounded-xl border border-amber-200/60 space-y-3">
            <p className="text-[11px] text-amber-800 uppercase font-bold tracking-wide">Canal Visa — Meute Homogène</p>
            <p className="text-[10px] text-amber-700/80">
              Les slots sont liés au type de visa. Un éclaireur F1 ne peut broadcaster qu'aux confinés F1. Assignez le canal correct pour ce dossier.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Canal Broadcast">
                <select
                  value={visaClassInput}
                  onChange={(e) => setVisaClassInput(e.target.value)}
                  className="w-full h-9 px-2 text-sm border rounded-md bg-white border-amber-200 font-mono"
                >
                  <option value="">— Non assigné —</option>
                  <optgroup label="NIV — Non-Immigrant (les plus courants)">
                    <option value="B1/B2">B1/B2 — Tourisme / Affaires</option>
                    <option value="F1">F1 — Étudiant</option>
                    <option value="J1">J1 — Échange</option>
                    <option value="H">H — Travail (H1B/H2/H3/H4)</option>
                    <option value="K">K — Fiancé(e) (K1/K2/K3/K4)</option>
                    <option value="L">L — Transfert intra-entreprise</option>
                    <option value="O">O — Aptitudes extraordinaires</option>
                    <option value="E">E — Commerçant/Investisseur</option>
                    <option value="R">R — Religieux</option>
                    <option value="M1">M1 — Étudiant technique</option>
                    <option value="P">P — Athlète/Artiste</option>
                  </optgroup>
                  <optgroup label="IV — Immigrant (résidence permanente)">
                    <option value="IR">IR — Famille immédiate citoyen US</option>
                    <option value="CR">CR — Conjoint récent citoyen US</option>
                    <option value="DV">DV — Visa Diversité (Loterie)</option>
                    <option value="EB">EB — Employment-Based</option>
                    <option value="F2A">F2A — Conjoint/Enfant résident permanent</option>
                    <option value="F2B">F2B — Enfant 21+ résident permanent</option>
                  </optgroup>
                </select>
              </Field>
              <Field label="Catégorie">
                <div className="h-9 flex items-center">
                  {usVisaCategory ? (
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${usVisaCategory === "NIV" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>
                      {usVisaCategory}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">Auto-détecté</span>
                  )}
                </div>
              </Field>
              <Field label="Code Visa">
                <div className="h-9 flex items-center">
                  <span className="text-xs font-mono text-slate-600">{usVisaCode ?? "—"}</span>
                </div>
              </Field>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs border-amber-300 text-amber-800 hover:bg-amber-100"
              disabled={!visaClassInput || savingVisaClass}
              onClick={async () => {
                setSavingVisaClass(true);
                try {
                  const category = ["IR", "CR", "DV", "EB", "F2A", "F2B", "F1-IV", "F3-IV", "F4-IV", "SB1", "SE", "SQ"].includes(visaClassInput) ? "IV" : "NIV";
                  await assignVisaClass({
                    applicationId: appId,
                    broadcastVisaClass: visaClassInput,
                    usVisaCategory: category as "NIV" | "IV",
                    usVisaCode: visaClassInput,
                  });
                  toast({ title: "Canal visa assigné", description: `Meute : ${visaClassInput} (${category})` });
                } catch (err: unknown) {
                  toast({ variant: "destructive", title: "Erreur", description: err instanceof Error ? err.message : "Échec" });
                } finally {
                  setSavingVisaClass(false);
                }
              }}
            >
              {savingVisaClass ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              Assigner le canal
            </Button>
          </div>
        )}

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
            <div className="flex items-center gap-1.5">
              <Input type="number" min={1} max={10} value={resetBudgetValue} onChange={(e) => setResetBudgetValue(e.target.value)} className="h-9 w-14 text-sm text-center font-mono bg-amber-50 border-amber-200" />
              <Button variant="outline" onClick={handleResetBudget} disabled={resettingBudget || !username.trim()} className="h-9 gap-2 text-sm border-amber-200 text-amber-700 hover:bg-amber-50">
                {resettingBudget ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Reset budget
              </Button>
            </div>
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
