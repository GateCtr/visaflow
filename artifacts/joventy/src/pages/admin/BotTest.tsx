import { useState, useCallback } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@convex/_generated/api";

import { VISA_PRICING } from "@convex/constants";
import {
  Wifi,
  WifiOff,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FlaskConical,
  Clock,
  ExternalLink,
  Eye,
  EyeOff,
  Bot,
  RefreshCw,
  Info,
  Copy,
  Check,
  Maximize2,
  LogOut,
} from "lucide-react";

type Destination = keyof typeof VISA_PRICING;

const DESTINATIONS: { key: Destination; flag: string; label: string }[] = [
  { key: "usa",      flag: "🇺🇸", label: "États-Unis" },
  { key: "canada",   flag: "🇨🇦", label: "Canada (VFS IRCC)" },
  { key: "dubai",    flag: "🇦🇪", label: "Dubaï (EAU)" },
  { key: "turkey",   flag: "🇹🇷", label: "Turquie" },
  { key: "india",    flag: "🇮🇳", label: "Inde" },
  { key: "schengen", flag: "🇪🇺", label: "Europe Schengen (CEV)" },
  { key: "spain",    flag: "🇪🇸", label: "Espagne (citaconsular.es)" },
];

interface PingResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  url: string;
  portalName: string;
  error: string | null;
}

const RESULT_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  login_success: {
    label: "Connexion réussie",
    color: "text-emerald-600",
    icon: <CheckCircle2 className="w-4 h-4 text-emerald-500" />,
  },
  logout_success: {
    label: "Déconnexion réussie",
    color: "text-slate-600",
    icon: <LogOut className="w-4 h-4 text-slate-500" />,
  },
  login_failed: {
    label: "Identifiants incorrects",
    color: "text-red-600",
    icon: <XCircle className="w-4 h-4 text-red-500" />,
  },
  captcha: {
    label: "CAPTCHA bloquant",
    color: "text-amber-600",
    icon: <AlertTriangle className="w-4 h-4 text-amber-500" />,
  },
  portal_ok: {
    label: "Portail accessible",
    color: "text-emerald-600",
    icon: <CheckCircle2 className="w-4 h-4 text-emerald-500" />,
  },
  portal_unreachable: {
    label: "Portail inaccessible",
    color: "text-red-600",
    icon: <XCircle className="w-4 h-4 text-red-500" />,
  },
  error: {
    label: "Erreur",
    color: "text-red-600",
    icon: <XCircle className="w-4 h-4 text-red-500" />,
  },
};

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminBotTest() {
  const pingPortal = useAction(api.hunter.pingPortal);
  const createBotTest = useMutation(api.hunter.createBotTest);
  const botTests = useQuery(api.hunter.listBotTests);

  const [pingResults, setPingResults] = useState<Record<string, PingResult | "loading" | null>>({});
  const [testForm, setTestForm] = useState<{
    destination: Destination;
    username: string;
    password: string;
    captchaKey: string;
    showPass: boolean;
  }>({
    destination: "usa",
    username: "",
    password: "",
    captchaKey: "",
    showPass: false,
  });
  const [testSubmitting, setTestSubmitting] = useState(false);
  const [testSuccess, setTestSuccess] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const checkTwoCaptchaBalanceRaw = useAction(api.hunter.checkTwoCaptchaBalanceRaw);
  const checkCapsolverBalanceRaw = useAction(api.hunter.checkCapsolverBalanceRaw);
  const checkAntiCaptchaBalanceRaw = useAction(api.hunter.checkAntiCaptchaBalanceRaw);
  const [captchaBalance, setCaptchaBalance] = useState<{ value: string; ok: boolean } | null>(null);
  const [captchaBalanceLoading, setCaptchaBalanceLoading] = useState(false);

  async function checkCaptchaBalance() {
    if (!testForm.captchaKey.trim()) return;
    setCaptchaBalanceLoading(true);
    setCaptchaBalance(null);
    try {
      const isSchengen = testForm.destination === "schengen";
      // Schengen → Anti-Captcha (CapSolver blackliste la sitekey CEV)
      const result = isSchengen
        ? await checkAntiCaptchaBalanceRaw({ apiKey: testForm.captchaKey.trim() })
        : await checkTwoCaptchaBalanceRaw({ apiKey: testForm.captchaKey.trim() });
      if (result.ok && result.balance !== null) {
        setCaptchaBalance({
          value: `$${result.balance.toFixed(2)} de solde`,
          ok: result.balance > 0,
        });
      } else {
        setCaptchaBalance({ value: result.error ?? "Erreur inconnue", ok: false });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur inconnue";
      setCaptchaBalance({ value: msg, ok: false });
    } finally {
      setCaptchaBalanceLoading(false);
    }
  }

  const handleCopy = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, []);

  async function handlePing(destination: Destination) {
    setPingResults((prev) => ({ ...prev, [destination]: "loading" }));
    try {
      const result = await pingPortal({ destination });
      setPingResults((prev) => ({ ...prev, [destination]: result as PingResult }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur inconnue";
      setPingResults((prev) => ({
        ...prev,
        [destination]: {
          ok: false,
          status: null,
          latencyMs: 0,
          url: "",
          portalName: "",
          error: msg,
        },
      }));
    }
  }

  async function handleSubmitBotTest() {
    setTestSubmitting(true);
    setTestError(null);
    setTestSuccess(false);
    try {
      await createBotTest({
        destination: testForm.destination,
        testUsername: testForm.username || undefined,
        testPassword: testForm.password || undefined,
        twoCaptchaApiKey: testForm.captchaKey || undefined,
        testType: "login",
      });
      setTestSuccess(true);
      setTestForm((f) => ({ ...f, username: "", password: "", captchaKey: "" }));
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setTestSubmitting(false);
    }
  }

  async function handleLogoutBotTest() {
    if (!testForm.username) {
      setTestError("Entrez l'identifiant (email) pour déconnecter la session.");
      return;
    }
    setTestSubmitting(true);
    setTestError(null);
    setTestSuccess(false);
    try {
      await createBotTest({
        destination: testForm.destination,
        testUsername: testForm.username,
        testType: "logout",
      });
      setTestSuccess(true);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setTestSubmitting(false);
    }
  }

  return (
    <>
    <div className="max-w-5xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center gap-3">
            <Bot className="w-7 h-7 text-secondary" />
            Bot & Portails
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Diagnostiquez la connectivité aux portails consulaires et testez le login du bot.
          </p>
        </div>

        <section className="bg-white rounded-2xl border border-border p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-5">
            <Wifi className="w-5 h-5 text-secondary" />
            <h2 className="text-base font-semibold text-primary">Test de connectivité HTTP</h2>
            <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1">
              <Info className="w-3.5 h-3.5" />
              Requête GET depuis les serveurs Convex (AWS)
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {DESTINATIONS.map(({ key, flag, label }) => {
              const pricing = VISA_PRICING[key];
              const pingState = pingResults[key];
              const isLoading = pingState === "loading";
              const result = pingState && pingState !== "loading" ? (pingState as PingResult) : null;

              return (
                <div
                  key={key}
                  className="border border-border rounded-xl p-4 flex flex-col gap-3 hover:border-secondary/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xl">{flag}</span>
                        <span className="font-semibold text-primary text-sm">{label}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-1">
                        {(pricing as { portalName: string }).portalName}
                      </div>
                    </div>
                    <a
                      href={(pricing as { portalUrl: string }).portalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-secondary transition-colors flex-shrink-0"
                      title="Ouvrir le portail"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>

                  {result && (
                    <div
                      className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${
                        result.ok
                          ? "bg-emerald-50 border border-emerald-200"
                          : "bg-red-50 border border-red-200"
                      }`}
                    >
                      {result.ok ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        {result.ok ? (
                          <span className="text-emerald-700 font-medium">
                            HTTP {result.status} — {formatLatency(result.latencyMs)}
                          </span>
                        ) : (
                          <span className="text-red-700 font-medium truncate block">
                            {result.error ?? `HTTP ${result.status}`}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => handlePing(key)}
                    disabled={isLoading}
                    className="w-full flex items-center justify-center gap-2 text-sm font-medium py-2 px-4 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-60 transition-colors"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Test en cours…
                      </>
                    ) : result ? (
                      <>
                        <RefreshCw className="w-4 h-4" />
                        Retester
                      </>
                    ) : (
                      <>
                        <Wifi className="w-4 h-4" />
                        Tester l'accès
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="bg-white rounded-2xl border border-border p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <FlaskConical className="w-5 h-5 text-secondary" />
            <h2 className="text-base font-semibold text-primary">Test de connexion Bot</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-5">
            Le bot Playwright exécutera ce test lors de son prochain cycle. Sans identifiants, il vérifie uniquement l'accessibilité du portail depuis la machine du bot.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Destination</label>
              <select
                value={testForm.destination}
                onChange={(e) => setTestForm((f) => ({ ...f, destination: e.target.value as Destination }))}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-secondary/30"
              >
                {DESTINATIONS.map(({ key, flag, label }) => (
                  <option key={key} value={key}>
                    {flag} {label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {testForm.destination === "schengen" ? "Clé Anti-Captcha" : "Clé 2Captcha"}{" "}
                <span className="text-muted-foreground font-normal">(optionnel)</span>
              </label>
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  value={testForm.captchaKey}
                  onChange={(e) => {
                    setTestForm((f) => ({ ...f, captchaKey: e.target.value }));
                    setCaptchaBalance(null);
                  }}
                  placeholder={testForm.destination === "schengen" ? "Clé API anti-captcha.com (vide = env serveur)" : "API key 2captcha.com"}
                  className="flex-1 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-secondary/30"
                />
                <button
                  type="button"
                  onClick={checkCaptchaBalance}
                  disabled={!testForm.captchaKey.trim() || captchaBalanceLoading}
                  className="flex-shrink-0 text-xs px-3 py-2 rounded-lg border border-border bg-slate-50 hover:bg-slate-100 disabled:opacity-40 transition-colors whitespace-nowrap"
                >
                  {captchaBalanceLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Vérifier solde"}
                </button>
              </div>
              {captchaBalance && (
                <p className={`mt-1.5 text-xs font-medium flex items-center gap-1 ${captchaBalance.ok ? "text-emerald-600" : "text-red-600"}`}>
                  {captchaBalance.ok
                    ? <CheckCircle2 className="w-3.5 h-3.5" />
                    : <XCircle className="w-3.5 h-3.5" />
                  }
                  {captchaBalance.value}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {testForm.destination === "schengen" ? "Email VOWINT" : "Identifiant portail"}{" "}
                <span className="text-muted-foreground font-normal">(optionnel)</span>
              </label>
              <input
                type="text"
                value={testForm.username}
                onChange={(e) => setTestForm((f) => ({ ...f, username: e.target.value }))}
                placeholder={testForm.destination === "schengen" ? "email@example.com (compte VOWINT)" : "Email ou identifiant"}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-secondary/30"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {testForm.destination === "schengen" ? "Mot de passe VOWINT" : "Mot de passe portail"}{" "}
                <span className="text-muted-foreground font-normal">(optionnel)</span>
              </label>
              <div className="relative">
                <input
                  type={testForm.showPass ? "text" : "password"}
                  value={testForm.password}
                  onChange={(e) => setTestForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="••••••••"
                  className="w-full border border-border rounded-lg px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-secondary/30"
                />
                <button
                  type="button"
                  onClick={() => setTestForm((f) => ({ ...f, showPass: !f.showPass }))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary"
                >
                  {testForm.showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          {/* Note contextuelle Schengen */}
          {testForm.destination === "schengen" && (
            <div className="sm:col-span-2 flex items-start gap-3 bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 text-sm">
              <span className="text-lg mt-0.5">🇪🇺</span>
              <div>
                <p className="font-semibold text-indigo-800 mb-0.5">Test VOWINT / CEV Schengen</p>
                <p className="text-xs text-indigo-600">
                  Les identifiants sont les accès <strong>VOWINT</strong> (visaonweb.diplomatie.be) du client — pas les accès CEV directement.
                  <br />
                  <strong>Sans identifiants :</strong> ping HTTP — accessibilité portail CEV depuis le serveur du bot.
                  <br />
                  <strong>Avec identifiants VOWINT :</strong> test complet — connexion VOWINT → clic « Prendre rendez-vous » → résolution hCaptcha <strong>(Anti-Captcha depuis env serveur ✅)</strong> → vérification disponibilité CEV (~0,002 $).
                  <br />
                  <span className="text-indigo-500">Clé Anti-Captcha optionnelle — si vide, la clé <code className="bg-indigo-100 px-0.5 rounded">ANTICAPTCHA_API_KEY</code> du serveur est utilisée automatiquement.</span>
                  <br />
                  <span className="text-amber-600 text-xs">⚠️ CapSolver bloqué pour cette sitekey — utiliser <strong>anti-captcha.com</strong> uniquement pour le CEV.</span>
                </p>
              </div>
            </div>
          )}

          {testSuccess && (
            <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 px-4 py-3 rounded-lg mb-4">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
              Test envoyé — le bot l'exécutera lors de son prochain cycle. Résultat visible ci-dessous.
            </div>
          )}
          {testError && (
            <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-lg mb-4">
              <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              {testError}
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleSubmitBotTest}
              disabled={testSubmitting}
              className="flex items-center gap-2 bg-primary text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-primary/90 disabled:opacity-60 transition-colors"
            >
              {testSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Envoi…
                </>
              ) : (
                <>
                  <FlaskConical className="w-4 h-4" />
                  Lancer le test
                </>
              )}
            </button>

            {testForm.destination === "usa" && testForm.username && (
              <button
                onClick={handleLogoutBotTest}
                disabled={testSubmitting}
                title="Déconnecter la session active de ce compte sur le portail USA"
                className="flex items-center gap-2 bg-slate-100 text-slate-700 text-sm font-medium px-4 py-2.5 rounded-xl hover:bg-red-50 hover:text-red-700 border border-slate-200 hover:border-red-200 disabled:opacity-60 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Déconnecter session
              </button>
            )}
          </div>
        </section>

        <section className="bg-white rounded-2xl border border-border p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-5">
            <Clock className="w-5 h-5 text-secondary" />
            <h2 className="text-base font-semibold text-primary">Historique des tests</h2>
            <span className="ml-auto text-xs text-muted-foreground">50 derniers tests</span>
          </div>

          {!botTests ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : botTests.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <Bot className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Aucun test effectué pour l'instant.</p>
            </div>
          ) : (
            <div className="overflow-x-auto overflow-y-auto max-h-[420px] rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white z-10">
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="pb-2 pt-2 px-1 text-left font-medium">Date</th>
                    <th className="pb-2 pt-2 px-1 text-left font-medium">Destination</th>
                    <th className="pb-2 pt-2 px-1 text-left font-medium">Type</th>
                    <th className="pb-2 pt-2 px-1 text-left font-medium">Statut</th>
                    <th className="pb-2 pt-2 px-1 text-left font-medium">Résultat</th>
                    <th className="pb-2 pt-2 px-1 text-left font-medium">Latence</th>
                    <th className="pb-2 pt-2 px-1 text-left font-medium">Détail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {botTests.map((test) => {
                    const dest = DESTINATIONS.find((d) => d.key === test.destination);
                    const resultMeta = test.result ? RESULT_META[test.result] : null;
                    const hasLogin = !!test.testUsername;

                    return (
                      <tr key={test._id} className="hover:bg-slate-50 transition-colors">
                        <td className="py-2.5 pr-4 text-muted-foreground whitespace-nowrap">
                          {formatDate(test.requestedAt)}
                        </td>
                        <td className="py-2.5 pr-4 whitespace-nowrap">
                          <span className="flex items-center gap-1.5">
                            <span>{dest?.flag ?? "🌍"}</span>
                            <span className="font-medium text-primary">{dest?.label ?? test.destination}</span>
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                              hasLogin
                                ? "bg-violet-100 text-violet-700"
                                : "bg-blue-100 text-blue-700"
                            }`}
                          >
                            {hasLogin ? (
                              <>
                                <Bot className="w-3 h-3" />
                                Login
                              </>
                            ) : (
                              <>
                                <Wifi className="w-3 h-3" />
                                Ping
                              </>
                            )}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 whitespace-nowrap">
                          {test.status === "pending" && (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                              <Clock className="w-3 h-3" />
                              En attente
                            </span>
                          )}
                          {test.status === "running" && (
                            <span className="inline-flex items-center gap-1 text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              En cours
                            </span>
                          )}
                          {test.status === "done" && (
                            <span className="inline-flex items-center gap-1 text-xs text-slate-600 bg-slate-50 px-2 py-0.5 rounded-full border border-slate-200">
                              <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                              Terminé
                            </span>
                          )}
                          {test.status === "failed" && (
                            <span className="inline-flex items-center gap-1 text-xs text-red-600 bg-red-50 px-2 py-0.5 rounded-full border border-red-200">
                              <XCircle className="w-3 h-3" />
                              Échoué
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4 whitespace-nowrap">
                          {resultMeta ? (
                            <span className={`inline-flex items-center gap-1 text-xs font-medium ${resultMeta.color}`}>
                              {resultMeta.icon}
                              {resultMeta.label}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4 whitespace-nowrap text-muted-foreground">
                          {test.latencyMs != null ? formatLatency(test.latencyMs) : "—"}
                        </td>
                        <td className="py-2.5 max-w-[260px]">
                          {test.errorMessage ? (
                            <div className="flex items-start gap-1.5 group">
                              <span className="text-xs text-red-600 leading-relaxed line-clamp-2 flex-1 min-w-0">
                                {test.errorMessage}
                              </span>
                              <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={() => handleCopy(test.errorMessage!, test._id)}
                                  title="Copier le message"
                                  className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
                                >
                                  {copiedId === test._id
                                    ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                                    : <Copy className="w-3.5 h-3.5" />
                                  }
                                </button>
                                <button
                                  onClick={() => setExpandedDetail(test.errorMessage!)}
                                  title="Voir le message complet"
                                  className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
                                >
                                  <Maximize2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ) : test.httpStatus ? (
                            <span className="text-xs text-muted-foreground">HTTP {test.httpStatus}</span>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
    </div>

    {/* Modal — message complet */}
    {expandedDetail && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
        onClick={() => setExpandedDetail(null)}
      >
        <div
          className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h3 className="font-semibold text-primary text-sm flex items-center gap-2">
              <XCircle className="w-4 h-4 text-red-500" />
              Message d'erreur complet
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleCopy(expandedDetail, "modal")}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
              >
                {copiedId === "modal"
                  ? <><Check className="w-3.5 h-3.5 text-emerald-500" /> Copié !</>
                  : <><Copy className="w-3.5 h-3.5" /> Copier</>
                }
              </button>
              <button
                onClick={() => setExpandedDetail(null)}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="p-5 overflow-auto max-h-[60vh]">
            <pre className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-xl p-4 whitespace-pre-wrap break-words font-mono leading-relaxed select-all">
              {expandedDetail}
            </pre>
          </div>
          <div className="px-5 py-3 border-t border-border bg-slate-50 text-xs text-muted-foreground">
            Cliquez en dehors pour fermer · <kbd className="bg-white border border-border rounded px-1 py-0.5 font-mono text-[10px]">Ctrl+A</kbd> pour tout sélectionner
          </div>
        </div>
      </div>
    )}
    </>
  );
}
