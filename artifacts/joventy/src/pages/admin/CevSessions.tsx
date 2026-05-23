import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  KeyRound,
  Plus,
  Pause,
  Play,
  Trash2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  Loader2,
  Info,
  X,
  Bot,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";

const POLL_INTERVAL_OPTIONS = [
  { ms: 30_000, label: "30 sec" },
  { ms: 60_000, label: "1 min" },
  { ms: 120_000, label: "2 min" },
  { ms: 300_000, label: "5 min" },
];

function formatRelative(ts?: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}j`;
}

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatTimeRemaining(validUntilMs?: number): { text: string; color: string; isExpired: boolean } {
  if (!validUntilMs) return { text: "—", color: "text-slate-500", isExpired: false };
  
  const now = Date.now();
  const remaining = validUntilMs - now;
  
  if (remaining <= 0) {
    return { text: "Expirée", color: "text-red-600", isExpired: true };
  }
  
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  
  if (remaining < 5 * 60_000) {
    return { text: `${minutes}m ${seconds}s`, color: "text-red-600", isExpired: false };
  }
  if (remaining < 10 * 60_000) {
    return { text: `${minutes}m`, color: "text-amber-600", isExpired: false };
  }
  
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return { text: `${hours}h ${minutes % 60}m`, color: "text-emerald-600", isExpired: false };
  }
  return { text: `${minutes}m`, color: "text-emerald-600", isExpired: false };
}

function StatusBadge({ status, lastResult, validUntilMs, loginFailCount }: { 
  status: string; 
  lastResult?: string;
  validUntilMs?: number;
  loginFailCount?: number;
}) {
  const timeInfo = formatTimeRemaining(validUntilMs);
  
  if (status === "needs_setup") {
    return (
      <div className="space-y-1">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-violet-50 text-violet-700 border border-violet-200">
          <Loader2 className="w-3 h-3 animate-spin" /> Configuration auto…
        </span>
      </div>
    );
  }
  if (status === "expired") {
    return (
      <div className="space-y-1">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200">
          <XCircle className="w-3 h-3" /> Session expirée
        </span>
      </div>
    );
  }
  if (status === "paused") {
    // Pause manuelle ou auto-pause après login failures
    if (loginFailCount && loginFailCount >= 3) {
      return (
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200">
            <ShieldAlert className="w-3 h-3" /> Identifiants invalides
          </span>
          <div className="text-xs text-red-600">
            {loginFailCount} échecs de login
          </div>
        </div>
      );
    }
    // Pause après slot trouvé
    if (lastResult === "slot_found") {
      return (
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 animate-pulse">
            🚨 Créneau trouvé
          </span>
          <div className="text-xs text-emerald-600">En attente de réservation</div>
        </div>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
        <Pause className="w-3 h-3" /> En pause
      </span>
    );
  }
  if (status === "active") {
    return (
      <div className="space-y-1">
        {lastResult === "slot_found" ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 animate-pulse">
            🚨 Créneau trouvé
          </span>
        ) : lastResult === "no_slot" ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
            <CheckCircle2 className="w-3 h-3" /> Polling actif
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
            <Loader2 className="w-3 h-3 animate-spin" /> 1er check…
          </span>
        )}
        {validUntilMs && (
          <div className={`text-xs font-medium ${timeInfo.color} flex items-center gap-1`}>
            <Clock className="w-3 h-3" />
            Expire dans {timeInfo.text}
          </div>
        )}
      </div>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
      <Loader2 className="w-3 h-3 animate-spin" /> En attente
    </span>
  );
}

// ─── Composant : Statistiques détaillées de session ───────────────────────────
function SessionStats({ session }: { session: any }) {
  const stats = [];
  
  if (session.checkCount) {
    stats.push(`${session.checkCount} checks`);
  }
  
  if (session.slotsFoundCount) {
    stats.push(`${session.slotsFoundCount} slot${session.slotsFoundCount > 1 ? 's' : ''} trouvé${session.slotsFoundCount > 1 ? 's' : ''}`);
  }
  
  if (session.autoRenewalCount) {
    stats.push(`${session.autoRenewalCount} renouvellement${session.autoRenewalCount > 1 ? 's' : ''}`);
  }
  
  if (session.totalPollingDurationMs) {
    stats.push(`Durée: ${formatDuration(session.totalPollingDurationMs)}`);
  }
  
  if (session.setupAttempts && session.setupAttempts > 1) {
    stats.push(`${session.setupAttempts} tentatives setup`);
  }
  
  return (
    <div className="text-xs text-slate-500 space-y-0.5">
      {stats.map((stat, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="w-1 h-1 rounded-full bg-slate-300" />
          {stat}
        </div>
      ))}
    </div>
  );
}

// ─── Modal : correction des identifiants VOWINT + relance setup ───────────────
interface ResetSession {
  _id: string;
  applicantName: string;
  loginFailCount: number;
  vowintEmail?: string;
  vowintAppUrl?: string;
  lastError?: string;
}

function ResetCredentialsModal({
  session,
  onClose,
}: {
  session: ResetSession;
  onClose: () => void;
}) {
  const updateCredentials = useMutation(api.cevSessions.updateVowintCredentials);

  const [email, setEmail] = useState(session.vowintEmail ?? "");
  const [password, setPassword] = useState("");
  const [appUrl, setAppUrl] = useState(session.vowintAppUrl ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim() !== "" && password.trim() !== "";

  async function submit() {
    setError(null);
    if (!email.trim()) { setError("Email VOWINT requis"); return; }
    if (!password.trim()) { setError("Mot de passe requis"); return; }
    setSubmitting(true);
    try {
      await updateCredentials({
        sessionId: session._id as Id<"cevSessions">,
        vowintEmail: email.trim(),
        vowintPassword: password.trim(),
        vowintAppUrl: appUrl.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-red-500" />
            <h2 className="text-lg font-semibold text-slate-900">
              Corriger les identifiants VOWINT
            </h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Contexte erreur */}
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-1.5">
            <p className="text-sm font-medium text-red-800 flex items-center gap-1.5">
              <XCircle className="w-4 h-4 shrink-0" />
              {session.loginFailCount} échec{session.loginFailCount > 1 ? "s" : ""} de login pour{" "}
              <span className="font-semibold">{session.applicantName}</span>
            </p>
            {session.lastError && (
              <p className="text-xs text-red-700 font-mono break-all">
                {session.lastError}
              </p>
            )}
            <p className="text-xs text-red-700 mt-1">
              Corrige l'email et/ou le mot de passe VOWINT ci-dessous, puis clique
              sur <strong>Relancer</strong>. Le compteur d'échecs sera remis à zéro
              et le bot retente immédiatement.
            </p>
          </div>

          {/* Email */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Email VOWINT *
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@example.com"
              autoComplete="off"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1A3F96] focus:border-transparent"
            />
          </div>

          {/* Mot de passe */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Nouveau mot de passe VOWINT *
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1A3F96] focus:border-transparent"
            />
            <p className="text-xs text-slate-500 mt-1">
              Laisse vide pour conserver l'ancien mot de passe… non — un nouveau
              mot de passe est <span className="font-medium">obligatoire</span> pour
              relancer.
            </p>
          </div>

          {/* URL optionnelle */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              URL dossier VOWINT{" "}
              <span className="text-slate-400 font-normal">(optionnel)</span>
            </label>
            <input
              type="url"
              value={appUrl}
              onChange={(e) => setAppUrl(e.target.value)}
              placeholder="https://visaonweb.diplomatie.be/Common/GetEAppointmentUrl?id=xxxxxxxx-xxxx-..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[#1A3F96] focus:border-transparent"
            />
            <p className="text-xs text-slate-500 mt-1">
              <strong>Multi-dossiers :</strong> Si le compte a plusieurs applications, colle ici l'URL complète 
              <code className="bg-slate-100 px-1 rounded">GetEAppointmentUrl?id=UUID</code> du bon dossier. 
              Le bot utilisera cet ID au lieu de prendre le premier trouvé.
            </p>
          </div>

          {/* Bannière info */}
          <div className="bg-violet-50 border border-violet-200 rounded-lg p-3 flex gap-2 text-xs text-violet-800">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Après validation, la session repasse en <strong>Configuration auto</strong> et le
              bot tente une nouvelle connexion dans la prochaine minute.
            </span>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2 text-sm text-red-800">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-slate-200">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium"
          >
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={submitting || !canSubmit}
            className="px-4 py-2 rounded-lg bg-[#1A3F96] text-white hover:bg-[#15347e] disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium flex items-center gap-2"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RotateCcw className="w-4 h-4" />
            )}
            Corriger et relancer
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal : nouvelle session ─────────────────────────────────────────────────
function NewSessionModal({ onClose }: { onClose: () => void }) {
  const apps = useQuery(api.applications.list, {});
  const upsert = useMutation(api.cevSessions.upsertSession);

  const cevApps = (apps ?? []).filter(
    (a: { destination: string }) => a.destination === "schengen"
  );

  const [applicationId, setApplicationId] = useState<string>("");
  const [vowintEmail, setVowintEmail] = useState("");
  const [vowintPassword, setVowintPassword] = useState("");
  const [vowintAppUrl, setVowintAppUrl] = useState("");
  const [pollMs, setPollMs] = useState(30_000);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !!applicationId && !!vowintEmail.trim() && !!vowintPassword.trim();

  async function submit() {
    setError(null);
    if (!applicationId) { setError("Sélectionne un dossier client"); return; }
    if (!vowintEmail.trim()) { setError("Email VOWINT requis"); return; }
    if (!vowintPassword.trim()) { setError("Mot de passe VOWINT requis"); return; }
    setSubmitting(true);
    try {
      await upsert({
        applicationId: applicationId as Id<"applications">,
        vowintEmail: vowintEmail.trim(),
        vowintPassword: vowintPassword.trim(),
        vowintAppUrl: vowintAppUrl.trim() || undefined,
        notes: notes.trim() || undefined,
        pollIntervalMs: pollMs,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-[#1A3F96]" />
            <h2 className="text-lg font-semibold text-slate-900">Nouvelle session CEV</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div className="bg-violet-50 border border-violet-200 rounded-lg p-4 flex gap-3 text-sm">
            <Info className="w-5 h-5 text-violet-600 shrink-0 mt-0.5" />
            <div className="text-violet-900 space-y-1.5">
              <p className="font-medium">Mode entièrement autonome</p>
              <p className="text-xs">
                Le bot se connecte à VOWINT avec tes identifiants, clique sur
                «&nbsp;Prendre rendez-vous&nbsp;», résout le hCaptcha automatiquement,
                puis démarre le polling. Quand la session expire, il se reconnecte
                seul sans intervention de ta part.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Dossier client *</label>
            <select
              value={applicationId}
              onChange={(e) => setApplicationId(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1A3F96] focus:border-transparent"
            >
              <option value="">— Sélectionner un dossier Schengen —</option>
              {cevApps.map((a: { _id: string; applicantName: string; visaType: string }) => (
                <option key={a._id} value={a._id}>
                  {a.applicantName} — {a.visaType}
                </option>
              ))}
            </select>
            {cevApps.length === 0 && (
              <p className="text-xs text-amber-600 mt-1">Aucun dossier Schengen trouvé. Crée d'abord un dossier client.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Email VOWINT *
              </label>
              <input
                type="email"
                value={vowintEmail}
                onChange={(e) => setVowintEmail(e.target.value)}
                placeholder="client@example.com"
                autoComplete="off"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1A3F96] focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Mot de passe VOWINT *
              </label>
              <input
                type="password"
                value={vowintPassword}
                onChange={(e) => setVowintPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1A3F96] focus:border-transparent"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              URL dossier VOWINT{" "}
              <span className="text-slate-400 font-normal">(optionnel — auto-détection si vide)</span>
            </label>
            <input
              type="url"
              value={vowintAppUrl}
              onChange={(e) => setVowintAppUrl(e.target.value)}
              placeholder="https://visaonweb.diplomatie.be/en/VisaApplication/Detail/..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[#1A3F96] focus:border-transparent"
            />
            <p className="text-xs text-slate-500 mt-1">
              Si fourni, le bot navigue directement vers ce dossier. Sinon, il détecte automatiquement le bouton «&nbsp;Prendre rendez-vous&nbsp;».
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Fréquence de check</label>
            <div className="flex gap-2">
              {POLL_INTERVAL_OPTIONS.map((opt) => (
                <button
                  key={opt.ms}
                  type="button"
                  onClick={() => setPollMs(opt.ms)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    pollMs === opt.ms
                      ? "bg-[#1A3F96] text-white border-[#1A3F96]"
                      : "bg-white text-slate-700 border-slate-300 hover:border-slate-400"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Note (optionnel)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="ex: Visa long séjour étudiant — urgent"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1A3F96] focus:border-transparent"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2 text-sm text-red-800">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-slate-200">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium"
          >
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={submitting || !canSubmit}
            className="px-4 py-2 rounded-lg bg-[#1A3F96] text-white hover:bg-[#15347e] disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium flex items-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Lancer la config auto
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────
export default function CevSessions() {
  const sessions = useQuery(api.cevSessions.listSessions);
  const setStatus = useMutation(api.cevSessions.setSessionStatus);
  const deleteSession = useMutation(api.cevSessions.deleteSession);

  const [showNewModal, setShowNewModal] = useState(false);
  const [resetSession, setResetSession] = useState<ResetSession | null>(null);
  const [restartSessionId, setRestartSessionId] = useState<Id<"cevSessions"> | null>(null);
  const [deleteSessionId, setDeleteSessionId] = useState<Id<"cevSessions"> | null>(null);

  const handleRestartSession = (sessionId: Id<"cevSessions">, applicantName: string) => {
    setRestartSessionId(sessionId);
  };

  const handleDeleteSession = (sessionId: Id<"cevSessions">, applicantName: string) => {
    setDeleteSessionId(sessionId);
  };

  const confirmRestartSession = () => {
    if (restartSessionId) {
      setStatus({ sessionId: restartSessionId, status: "needs_setup" });
      setRestartSessionId(null);
    }
  };

  const confirmDeleteSession = () => {
    if (deleteSessionId) {
      deleteSession({ sessionId: deleteSessionId });
      setDeleteSessionId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Sessions CEV — Polling Schengen</h1>
          <p className="text-sm text-slate-600 mt-1">
            Connexion autonome VOWINT + polling automatique — zéro intervention manuelle.
          </p>
        </div>
        <button
          onClick={() => setShowNewModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1A3F96] text-white hover:bg-[#15347e] text-sm font-medium"
        >
          <Plus className="w-4 h-4" /> Nouvelle session
        </button>
      </div>

      {sessions === undefined ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-12 text-center">
          <KeyRound className="w-10 h-10 mx-auto text-slate-400 mb-3" />
          <h3 className="text-base font-medium text-slate-900">Aucune session CEV active</h3>
          <p className="text-sm text-slate-600 mt-1 mb-4">
            Crée une session : le bot se connecte à VOWINT et démarre le polling automatiquement.
          </p>
          <button
            onClick={() => setShowNewModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1A3F96] text-white hover:bg-[#15347e] text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> Créer la première session
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Dossier</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Statut</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Session</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Statistiques</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Activité</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sessions.map((s: any) => {
                const loginFailCount: number = s.loginFailCount ?? 0;
                const isLoginPaused = s.status === "paused" && loginFailCount >= 3;
                const isSlotPaused = s.status === "paused" && s.lastResult === "slot_found";

                return (
                  <tr key={s._id} className={`hover:bg-slate-50 ${isLoginPaused ? "bg-red-50/30" : isSlotPaused ? "bg-emerald-50/30" : ""}`}>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-slate-900">{s.applicantName}</div>
                      <div className="text-xs text-slate-500">{s.visaType}</div>
                      {s.notes && (
                        <div className="text-xs text-slate-400 italic mt-0.5 max-w-xs truncate" title={s.notes}>
                          {s.notes}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge 
                        status={s.status} 
                        lastResult={s.lastResult} 
                        validUntilMs={s.validUntilMs}
                        loginFailCount={s.loginFailCount}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs font-mono text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                        {s.sessionCookiePreview}
                      </code>
                      {s.autoRenewalCount && s.autoRenewalCount > 0 && (
                        <div className="text-xs text-violet-600 mt-1 flex items-center gap-1">
                          <RotateCcw className="w-3 h-3" />
                          {s.autoRenewalCount} renouvellement{s.autoRenewalCount > 1 ? "s" : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <SessionStats session={s} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-slate-700 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {s.lastCheckAt ? `il y a ${formatRelative(s.lastCheckAt)}` : "—"}
                      </div>
                      {s.status === "active" && (
                        <div className="text-xs text-slate-500 mt-0.5">
                          toutes les {Math.round((s.pollIntervalMs ?? 30_000) / 1000)}s
                        </div>
                      )}
                      {s.lastError && (
                        <div className="text-xs text-red-600 mt-0.5 max-w-xs truncate" title={s.lastError}>
                          {s.lastError}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        {/* Pause : session active sans login failure */}
                        {s.status === "active" && (
                          <button
                            onClick={() => setStatus({ sessionId: s._id, status: "paused" })}
                            className="p-1.5 rounded hover:bg-slate-100 text-slate-600"
                            title="Mettre en pause"
                          >
                            <Pause className="w-4 h-4" />
                          </button>
                        )}

                        {/* Reprendre : session pausée manuellement (sans login failure) */}
                        {s.status === "paused" && loginFailCount < 3 && s.lastResult !== "slot_found" && (
                          <button
                            onClick={() => setStatus({ sessionId: s._id, status: "active" })}
                            className="p-1.5 rounded hover:bg-slate-100 text-emerald-600"
                            title="Reprendre le polling"
                          >
                            <Play className="w-4 h-4" />
                          </button>
                        )}

                        {/* Corriger les identifiants VOWINT : session auto-pausée après login failures */}
                        {isLoginPaused && (
                          <button
                            onClick={() =>
                              setResetSession({
                                _id: s._id,
                                applicantName: s.applicantName,
                                loginFailCount,
                                vowintEmail: s.vowintEmail,
                                vowintAppUrl: s.vowintAppUrl,
                                lastError: s.lastError,
                              })
                            }
                            className="p-1.5 rounded hover:bg-red-50 text-red-600"
                            title="Corriger les identifiants VOWINT et relancer"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        )}

                        {/* Relancer config auto : session expirée */}
                        {s.status === "expired" && (
                          <AlertDialog open={restartSessionId === s._id} onOpenChange={(open) => !open && setRestartSessionId(null)}>
                            <AlertDialogTrigger asChild>
                              <button
                                onClick={() => handleRestartSession(s._id, s.applicantName)}
                                className="p-1.5 rounded hover:bg-violet-50 text-violet-600"
                                title="Relancer la configuration auto"
                              >
                                <Bot className="w-4 h-4" />
                              </button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Relancer la configuration auto</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Êtes-vous sûr de vouloir relancer la configuration auto pour {s.applicantName} ?
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Annuler</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={confirmRestartSession}
                                  className="bg-violet-600 hover:bg-violet-700"
                                >
                                  Relancer
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}

                        {/* Supprimer */}
                        <AlertDialog open={deleteSessionId === s._id} onOpenChange={(open) => !open && setDeleteSessionId(null)}>
                          <AlertDialogTrigger asChild>
                            <button
                              onClick={() => handleDeleteSession(s._id, s.applicantName)}
                              className="p-1.5 rounded hover:bg-red-50 text-red-600"
                              title="Supprimer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Supprimer la session</AlertDialogTitle>
                              <AlertDialogDescription>
                                Êtes-vous sûr de vouloir supprimer la session pour {s.applicantName} ?
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Annuler</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={confirmDeleteSession}
                                className="bg-red-600 hover:bg-red-700"
                              >
                                Supprimer
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showNewModal && <NewSessionModal onClose={() => setShowNewModal(false)} />}
      {resetSession && (
        <ResetCredentialsModal
          session={resetSession}
          onClose={() => setResetSession(null)}
        />
      )}
    </div>
  );
}
