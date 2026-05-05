import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
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

function StatusBadge({ status, lastResult }: { status: string; lastResult?: string }) {
  if (status === "needs_setup") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-violet-50 text-violet-700 border border-violet-200">
        <Loader2 className="w-3 h-3 animate-spin" /> Configuration auto…
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200">
        <XCircle className="w-3 h-3" /> Session expirée
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
        <Pause className="w-3 h-3" /> En pause
      </span>
    );
  }
  if (lastResult === "slot_found") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 animate-pulse">
        🚨 Créneau trouvé
      </span>
    );
  }
  if (lastResult === "no_slot") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
        <CheckCircle2 className="w-3 h-3" /> Polling actif
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
      <Loader2 className="w-3 h-3 animate-spin" /> En attente 1er check
    </span>
  );
}

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

export default function CevSessions() {
  const sessions = useQuery(api.cevSessions.listSessions);
  const setStatus = useMutation(api.cevSessions.setSessionStatus);
  const deleteSession = useMutation(api.cevSessions.deleteSession);
  const [showModal, setShowModal] = useState(false);

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
          onClick={() => setShowModal(true)}
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
            onClick={() => setShowModal(true)}
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
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Checks</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Dernier check</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Fréquence</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sessions.map((s) => (
                <tr key={s._id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-slate-900">{s.applicantName}</div>
                    <div className="text-xs text-slate-500">{s.visaType}</div>
                    {s.notes && <div className="text-xs text-slate-400 italic mt-0.5">{s.notes}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={s.status} lastResult={s.lastResult} />
                    {s.consecutiveErrors && s.consecutiveErrors > 0 ? (
                      <div className="text-xs text-amber-600 mt-1">
                        {s.consecutiveErrors} erreur{s.consecutiveErrors > 1 ? "s" : ""} consécutive{s.consecutiveErrors > 1 ? "s" : ""}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs font-mono text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                      {s.sessionCookiePreview}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700">{s.checkCount ?? 0}</td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-slate-700 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      il y a {formatRelative(s.lastCheckAt)}
                    </div>
                    {s.lastError && (
                      <div className="text-xs text-red-600 mt-0.5 max-w-xs truncate" title={s.lastError}>
                        {s.lastError}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    toutes les {Math.round((s.pollIntervalMs ?? 30_000) / 1000)}s
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      {s.status === "active" && (
                        <button
                          onClick={() => setStatus({ sessionId: s._id, status: "paused" })}
                          className="p-1.5 rounded hover:bg-slate-100 text-slate-600"
                          title="Mettre en pause"
                        >
                          <Pause className="w-4 h-4" />
                        </button>
                      )}
                      {s.status === "paused" && (
                        <button
                          onClick={() => setStatus({ sessionId: s._id, status: "active" })}
                          className="p-1.5 rounded hover:bg-slate-100 text-emerald-600"
                          title="Reprendre"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                      )}
                      {(s.status === "expired") && (
                        <button
                          onClick={() => setStatus({ sessionId: s._id, status: "needs_setup" })}
                          className="p-1.5 rounded hover:bg-violet-50 text-violet-600"
                          title="Relancer la configuration auto"
                        >
                          <Bot className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (confirm(`Supprimer la session pour ${s.applicantName} ?`)) {
                            deleteSession({ sessionId: s._id });
                          }
                        }}
                        className="p-1.5 rounded hover:bg-red-50 text-red-600"
                        title="Supprimer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && <NewSessionModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
