import { useState } from "react";
import { flushSync } from "react-dom";
import { Link, useLocation } from "wouter";
import { useSignIn } from "@clerk/react";
import {
  Eye,
  EyeOff,
  ArrowRight,
  CheckCircle2,
  Globe,
  Lock,
  Clock,
  Mail,
  Phone,
  KeyRound,
} from "lucide-react";
import { JoventyLogo } from "@/components/JoventyLogo";

const OAUTH_STRATEGIES = [
  {
    strategy: "oauth_google" as const,
    label: "Google",
    disabled: false,
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
      </svg>
    ),
  },
  {
    strategy: "oauth_apple" as const,
    label: "Apple",
    disabled: true,
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
      </svg>
    ),
  },
  {
    strategy: "oauth_facebook" as const,
    label: "Facebook",
    disabled: true,
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#1877F2">
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
      </svg>
    ),
  },
];

type Method = "email-password" | "phone";
type Step = "credentials" | "otp";

export default function Login() {
  const { signIn } = useSignIn();
  const [, setLocation] = useLocation();

  const [method, setMethod] = useState<Method>("email-password");
  const [step, setStep] = useState<Step>("credentials");

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadingOAuth, setLoadingOAuth] = useState<string | null>(null);
  const [error, setError] = useState("");

  const handleOAuth = async (strategy: "oauth_google" | "oauth_apple" | "oauth_facebook", isDisabled?: boolean) => {
    if (isDisabled) return;
    if (!signIn || loadingOAuth) return;
    flushSync(() => {
      setError("");
      setLoadingOAuth(strategy);
    });
    const base = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("La connexion Google n'a pas répondu. Vérifiez que Google OAuth est activé dans votre Clerk Dashboard.")), 15000)
      );
      const { error } = await Promise.race([
        signIn.sso({
          strategy,
          redirectCallbackUrl: `${window.location.origin}${base}/sso-callback`,
          redirectUrl: `${window.location.origin}${base}/dashboard`,
        }),
        timeout,
      ]);
      if (error) {
        setError(error.longMessage ?? error.message ?? "Erreur OAuth");
        setLoadingOAuth(null);
      }
      // Pas d'erreur = redirect en cours, on laisse le spinner (la page va changer)
    } catch (e: any) {
      const msg = e?.errors?.[0]?.longMessage ?? e?.errors?.[0]?.message ?? e?.message;
      setError(msg || "Erreur de connexion Google.");
      setLoadingOAuth(null);
    }
  };

  const switchMethod = (m: Method) => {
    setMethod(m);
    setStep("credentials");
    setOtpCode("");
    setError("");
  };

  /* ---- EMAIL + PASSWORD login ---- */
  const handleEmailPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn) return;
    setIsLoading(true);
    setError("");
    try {
      const { error: err } = await signIn.password({ identifier: email, password });
      if (err) { setError(err.longMessage || err.message); return; }
      if (signIn.status === "complete") {
        await signIn.finalize();
        setLocation("/dashboard");
      } else if (signIn.status === "needs_first_factor") {
        const { error: sendErr } = await signIn.emailCode.sendCode();
        if (sendErr) { setError(sendErr.longMessage || sendErr.message); return; }
        setStep("otp");
      }
    } catch (e: any) {
      setError(e?.errors?.[0]?.longMessage || e?.errors?.[0]?.message || "Identifiants incorrects");
    } finally {
      setIsLoading(false);
    }
  };

  /* ---- PHONE OTP login ---- */
  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn) return;
    setIsLoading(true);
    setError("");
    try {
      const { error: err } = await signIn.create({ identifier: phone });
      if (err) { setError(err.longMessage || err.message); return; }
      const { error: sendErr } = await signIn.phoneCode.sendCode();
      if (sendErr) {
        setError(sendErr.longMessage || sendErr.message || "Ce numéro n'est pas enregistré ou ne supporte pas la connexion par SMS.");
        return;
      }
      setStep("otp");
    } catch (e: any) {
      setError(e?.errors?.[0]?.longMessage || e?.errors?.[0]?.message || "Numéro de téléphone invalide");
    } finally {
      setIsLoading(false);
    }
  };

  /* ---- OTP verification ---- */
  const handleOtpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn) return;
    setIsLoading(true);
    setError("");
    try {
      const { error: err } =
        method === "phone"
          ? await signIn.phoneCode.verifyCode({ code: otpCode })
          : await signIn.emailCode.verifyCode({ code: otpCode });

      if (err) { setError(err.longMessage || err.message); return; }
      if (signIn.status === "complete") {
        await signIn.finalize();
        setLocation("/dashboard");
      }
    } catch (e: any) {
      setError(e?.errors?.[0]?.message || "Code invalide ou expiré");
    } finally {
      setIsLoading(false);
    }
  };

  const identifier = method === "phone" ? phone : email;

  const METHOD_TABS: { key: Method; label: string; icon: typeof KeyRound; disabled?: boolean }[] = [
    { key: "email-password", label: "Email + mdp", icon: KeyRound },
    { key: "phone", label: "Téléphone", icon: Phone, disabled: true },
  ];

  return (
    <div className="min-h-screen flex">
      {/* Left Panel */}
      <div className="hidden lg:flex lg:w-5/12 xl:w-1/2 bg-brand-gradient flex-col justify-between p-12 relative overflow-hidden">
        <div className="absolute inset-0 opacity-5">
          <div className="absolute top-1/4 -left-20 w-96 h-96 rounded-full border border-white/20" />
          <div className="absolute bottom-1/4 -right-20 w-80 h-80 rounded-full border border-white/20" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full border border-white" />
        </div>

        <div className="relative z-10">
          <JoventyLogo href="/" variant="dark" size="md" />
        </div>

        <div className="relative z-10 space-y-8">
          <div>
            <p className="text-secondary text-sm font-semibold tracking-widest uppercase mb-4">
              Espace Sécurisé
            </p>
            <h1 className="text-4xl xl:text-5xl font-serif font-bold text-white leading-tight">
              Votre visa,<br />
              <span className="text-secondary">notre expertise.</span>
            </h1>
            <p className="mt-4 text-white/70 text-lg leading-relaxed">
              Accédez à votre espace personnel pour suivre vos dossiers en temps réel.
            </p>
          </div>

          <div className="space-y-4">
            {[
              { icon: Globe, text: "USA, Espagne, Dubaï, Turquie, Inde & plus" },
              { icon: Clock, text: "Suivi en temps réel de votre dossier" },
              { icon: Lock, text: "Vos données protégées et confidentielles" },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-secondary" />
                </div>
                <span className="text-white/80 text-sm">{text}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-10">
          <p className="text-white/40 text-xs">© 2025 Joventy · Premium Visa Assistance RDC</p>
        </div>
      </div>

      {/* Right Panel */}
      <div className="flex-1 flex flex-col justify-center px-6 sm:px-12 lg:px-16 xl:px-24 py-12 bg-background">
        <div className="w-full max-w-md mx-auto">

          <div className="lg:hidden mb-8">
            <JoventyLogo href="/" variant="sidebar" size="sm" />
          </div>

          {step === "credentials" ? (
            <>
              <div className="mb-8">
                <h2 className="text-3xl font-serif font-bold text-primary">Connexion</h2>
                <p className="mt-2 text-slate-500">Bienvenue ! Accédez à votre espace.</p>
              </div>

              {/* OAuth — Google + Apple + Facebook */}
              <div className="grid grid-cols-3 gap-3 mb-6">
                {OAUTH_STRATEGIES.map(({ strategy, label, icon, disabled: isProviderDisabled }) => {
                  const isThis = loadingOAuth === strategy;
                  const isDisabled = isProviderDisabled || !!loadingOAuth || isLoading;
                  return (
                    <button
                      key={strategy}
                      onClick={() => handleOAuth(strategy, isProviderDisabled)}
                      disabled={isDisabled}
                      title={isProviderDisabled ? "Bientôt disponible" : undefined}
                      className={`relative flex items-center justify-center gap-2 h-12 rounded-xl border text-sm font-medium transition-all duration-200 shadow-sm
                        ${isProviderDisabled
                          ? "bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed opacity-50 grayscale"
                          : isThis
                          ? "bg-primary/5 border-primary/30 text-primary scale-[0.98]"
                          : isDisabled
                          ? "bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed opacity-60"
                          : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300 hover:shadow-md active:scale-[0.97] cursor-pointer"
                        }`}
                    >
                      {isThis ? (
                        <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                      ) : icon}
                      <span>{label}</span>
                      {isProviderDisabled && (
                        <span className="absolute -top-2 -right-1 text-[9px] font-semibold bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded-full leading-none">
                          Bientôt
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="relative mb-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-200" />
                </div>
                <div className="relative flex justify-center">
                  <span className="px-3 bg-slate-50 text-xs text-slate-400 uppercase tracking-wider">
                    ou continuer avec
                  </span>
                </div>
              </div>

              {/* Method tabs: Email+mdp | Téléphone (bientôt) */}
              <div className="flex rounded-xl bg-slate-100 p-1 mb-5 gap-1">
                {METHOD_TABS.map(({ key, label, icon: Icon, disabled: tabDisabled }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => !tabDisabled && switchMethod(key)}
                    disabled={tabDisabled}
                    title={tabDisabled ? "Bientôt disponible" : undefined}
                    className={`relative flex-1 flex items-center justify-center gap-1.5 h-9 rounded-lg text-xs font-medium transition-all ${
                      tabDisabled
                        ? "text-slate-300 cursor-not-allowed"
                        : method === key
                        ? "bg-white text-primary shadow-sm"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{label}</span>
                    <span className="sm:hidden">{key === "email-password" ? "Email" : "Tel"}</span>
                    {tabDisabled && (
                      <span className="absolute -top-2 -right-1 text-[9px] font-semibold bg-slate-200 text-slate-400 px-1.5 py-0.5 rounded-full leading-none">
                        Bientôt
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {/* EMAIL + PASSWORD */}
              {method === "email-password" && (
                <form onSubmit={handleEmailPasswordSubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-primary mb-1.5">Adresse email</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="vous@exemple.com"
                      required
                      className="w-full h-12 px-4 rounded-xl border border-slate-200 bg-white text-primary placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary transition-all"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-sm font-medium text-primary">Mot de passe</label>
                      <button type="button" className="text-xs text-secondary hover:text-secondary/70 font-medium transition-colors">
                        Mot de passe oublié ?
                      </button>
                    </div>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        required
                        className="w-full h-12 px-4 pr-12 rounded-xl border border-slate-200 bg-white text-primary placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary transition-all"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  {error && <div className="p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm">{error}</div>}
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full h-12 rounded-xl bg-primary hover:bg-primary/85 text-white font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed mt-2"
                  >
                    {isLoading ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <>Se connecter <ArrowRight className="w-4 h-4" /></>}
                  </button>
                </form>
              )}

              {/* PHONE OTP */}
              {method === "phone" && (
                <form onSubmit={handlePhoneSubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-primary mb-1.5">Numéro de téléphone</label>
                    <div className="flex gap-2">
                      <div className="flex items-center h-12 px-3 rounded-xl border border-slate-200 bg-white text-slate-500 text-sm font-medium whitespace-nowrap">
                        🇨🇩 +243
                      </div>
                      <input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone("+243" + e.target.value.replace(/^\+243/, "").replace(/\D/g, ""))}
                        placeholder="8X XXX XXXX"
                        required
                        className="flex-1 h-12 px-4 rounded-xl border border-slate-200 bg-white text-primary placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary transition-all"
                      />
                    </div>
                    <p className="text-xs text-slate-400 mt-1.5">Un code SMS vous sera envoyé pour confirmer.</p>
                  </div>
                  {error && <div className="p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm">{error}</div>}
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full h-12 rounded-xl bg-primary hover:bg-primary/85 text-white font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isLoading ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <><Phone className="w-4 h-4" /> Recevoir le code SMS <ArrowRight className="w-4 h-4" /></>}
                  </button>
                </form>
              )}

              <p className="mt-6 text-center text-sm text-slate-500">
                Pas encore de compte ?{" "}
                <Link href="/register" className="font-semibold text-primary hover:text-secondary transition-colors">
                  Créer un dossier
                </Link>
              </p>
            </>
          ) : (
            /* OTP Step */
            <>
              <div className="mb-8">
                <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center mb-4">
                  {method === "phone"
                    ? <Phone className="w-7 h-7 text-secondary" />
                    : <Mail className="w-7 h-7 text-secondary" />
                  }
                </div>
                <h2 className="text-3xl font-serif font-bold text-primary">Vérification</h2>
                <p className="mt-2 text-slate-500">
                  Un code à 6 chiffres a été envoyé{" "}
                  {method === "phone"
                    ? <>par SMS au <span className="font-semibold text-primary">{identifier}</span></>
                    : <>à <span className="font-semibold text-primary">{identifier}</span></>
                  }
                </p>
              </div>

              <form onSubmit={handleOtpVerify} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-primary mb-1.5">Code de vérification</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    maxLength={6}
                    required
                    autoFocus
                    className="w-full h-14 px-4 rounded-xl border border-slate-200 bg-white text-primary text-center text-2xl font-mono tracking-[0.5em] placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary transition-all"
                  />
                </div>

                {error && <div className="p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm">{error}</div>}

                <button
                  type="submit"
                  disabled={isLoading || otpCode.length < 6}
                  className="w-full h-12 rounded-xl bg-primary hover:bg-primary/85 text-white font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isLoading ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <><CheckCircle2 className="w-4 h-4" /> Confirmer</>}
                </button>

                <button
                  type="button"
                  onClick={() => { setStep("credentials"); setOtpCode(""); setError(""); }}
                  className="w-full text-sm text-slate-500 hover:text-primary transition-colors"
                >
                  ← Retour
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
