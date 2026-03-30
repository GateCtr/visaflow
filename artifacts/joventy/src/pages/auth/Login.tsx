import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useSignIn } from "@clerk/clerk-react";
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
} from "lucide-react";
import { JoventyLogo } from "@/components/JoventyLogo";

const OAUTH_STRATEGIES = [
  {
    strategy: "oauth_google" as const,
    label: "Google",
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
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
      </svg>
    ),
  },
  {
    strategy: "oauth_facebook" as const,
    label: "Facebook",
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#1877F2">
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
      </svg>
    ),
  },
];

type Method = "email" | "phone";
type Step = "credentials" | "otp";

export default function Login() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [, setLocation] = useLocation();

  const [method, setMethod] = useState<Method>("email");
  const [step, setStep] = useState<Step>("credentials");

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleOAuth = async (strategy: "oauth_google" | "oauth_apple" | "oauth_facebook") => {
    if (!isLoaded) return;
    setError("");
    try {
      await signIn.authenticateWithRedirect({
        strategy,
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/dashboard",
      });
    } catch (err: any) {
      setError(err.errors?.[0]?.message || "Erreur de connexion OAuth");
    }
  };

  const switchMethod = (m: Method) => {
    setMethod(m);
    setStep("credentials");
    setOtpCode("");
    setError("");
  };

  /* ---- EMAIL + PASSWORD login ---- */
  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded) return;
    setIsLoading(true);
    setError("");
    try {
      const result = await signIn.create({ identifier: email, password });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        setLocation("/dashboard");
      } else if (result.status === "needs_first_factor") {
        const factor = result.supportedFirstFactors?.find(
          (f) => f.strategy === "email_code"
        );
        if (factor) {
          await signIn.prepareFirstFactor({
            strategy: "email_code",
            emailAddressId: (factor as any).emailAddressId,
          });
          setStep("otp");
        }
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.longMessage || err.errors?.[0]?.message || "Identifiants incorrects");
    } finally {
      setIsLoading(false);
    }
  };

  /* ---- PHONE login (SMS OTP) ---- */
  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded) return;
    setIsLoading(true);
    setError("");
    try {
      const result = await signIn.create({ identifier: phone });
      const phoneFactor = result.supportedFirstFactors?.find(
        (f) => f.strategy === "phone_code"
      );
      if (phoneFactor) {
        await signIn.prepareFirstFactor({
          strategy: "phone_code",
          phoneNumberId: (phoneFactor as any).phoneNumberId,
        });
        setStep("otp");
      } else {
        setError("Ce numéro n'est pas enregistré ou ne supporte pas la connexion par SMS.");
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.longMessage || err.errors?.[0]?.message || "Numéro de téléphone invalide");
    } finally {
      setIsLoading(false);
    }
  };

  /* ---- OTP verification (both email and phone) ---- */
  const handleOtpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded) return;
    setIsLoading(true);
    setError("");
    try {
      const result = await signIn.attemptFirstFactor({
        strategy: method === "phone" ? "phone_code" : "email_code",
        code: otpCode,
      });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        setLocation("/dashboard");
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.message || "Code invalide ou expiré");
    } finally {
      setIsLoading(false);
    }
  };

  const identifier = method === "phone" ? phone : email;

  return (
    <div className="min-h-screen flex">
      {/* Left Panel — Navy Brand */}
      <div className="hidden lg:flex lg:w-5/12 xl:w-1/2 bg-[#0A192F] flex-col justify-between p-12 relative overflow-hidden">
        <div className="absolute inset-0 opacity-5">
          <div className="absolute top-1/4 -left-20 w-96 h-96 rounded-full border border-[#D4AF37]" />
          <div className="absolute bottom-1/4 -right-20 w-80 h-80 rounded-full border border-[#D4AF37]" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full border border-white" />
        </div>

        <div className="relative z-10">
          <JoventyLogo href="/" variant="dark" size="md" />
        </div>

        <div className="relative z-10 space-y-8">
          <div>
            <p className="text-[#D4AF37] text-sm font-semibold tracking-widest uppercase mb-4">
              Espace Sécurisé
            </p>
            <h1 className="text-4xl xl:text-5xl font-serif font-bold text-white leading-tight">
              Votre visa,<br />
              <span className="text-[#D4AF37]">notre expertise.</span>
            </h1>
            <p className="mt-4 text-slate-400 text-lg leading-relaxed">
              Accédez à votre espace personnel pour suivre vos dossiers en temps réel.
            </p>
          </div>

          <div className="space-y-4">
            {[
              { icon: Globe, text: "USA, Dubaï, Turquie, Inde & plus" },
              { icon: Clock, text: "Suivi en temps réel de votre dossier" },
              { icon: Lock, text: "Vos données protégées et confidentielles" },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[#D4AF37]/10 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-[#D4AF37]" />
                </div>
                <span className="text-slate-300 text-sm">{text}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-10">
          <p className="text-slate-600 text-xs">© 2025 Joventy · Premium Visa Assistance RDC</p>
        </div>
      </div>

      {/* Right Panel — Form */}
      <div className="flex-1 flex flex-col justify-center px-6 sm:px-12 lg:px-16 xl:px-24 py-12 bg-slate-50">
        <div className="w-full max-w-md mx-auto">

          {/* Mobile logo */}
          <div className="lg:hidden mb-8">
            <JoventyLogo href="/" variant="sidebar" size="sm" />
          </div>

          {step === "credentials" ? (
            <>
              <div className="mb-8">
                <h2 className="text-3xl font-serif font-bold text-[#0A192F]">Connexion</h2>
                <p className="mt-2 text-slate-500">Bienvenue ! Accédez à votre espace.</p>
              </div>

              {/* OAuth buttons */}
              <div className="grid grid-cols-3 gap-3 mb-6">
                {OAUTH_STRATEGIES.map(({ strategy, label, icon }) => (
                  <button
                    key={strategy}
                    onClick={() => handleOAuth(strategy)}
                    className="flex items-center justify-center gap-2 h-12 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 text-slate-700 text-sm font-medium transition-all duration-150 shadow-sm"
                  >
                    {icon}
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                ))}
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

              {/* Email / Phone toggle */}
              <div className="flex rounded-xl bg-slate-100 p-1 mb-5">
                <button
                  type="button"
                  onClick={() => switchMethod("email")}
                  className={`flex-1 flex items-center justify-center gap-2 h-9 rounded-lg text-sm font-medium transition-all ${
                    method === "email"
                      ? "bg-white text-[#0A192F] shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <Mail className="w-4 h-4" /> Email
                </button>
                <button
                  type="button"
                  onClick={() => switchMethod("phone")}
                  className={`flex-1 flex items-center justify-center gap-2 h-9 rounded-lg text-sm font-medium transition-all ${
                    method === "phone"
                      ? "bg-white text-[#0A192F] shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <Phone className="w-4 h-4" /> Téléphone
                </button>
              </div>

              {/* EMAIL form */}
              {method === "email" && (
                <form onSubmit={handleEmailSubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-[#0A192F] mb-1.5">
                      Adresse email
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="vous@exemple.com"
                      required
                      className="w-full h-12 px-4 rounded-xl border border-slate-200 bg-white text-[#0A192F] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0A192F]/10 focus:border-[#0A192F] transition-all"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-sm font-medium text-[#0A192F]">
                        Mot de passe
                      </label>
                      <button
                        type="button"
                        className="text-xs text-[#D4AF37] hover:text-[#D4AF37]/80 font-medium transition-colors"
                      >
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
                        className="w-full h-12 px-4 pr-12 rounded-xl border border-slate-200 bg-white text-[#0A192F] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0A192F]/10 focus:border-[#0A192F] transition-all"
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

                  {error && (
                    <div className="p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full h-12 rounded-xl bg-[#0A192F] hover:bg-[#0A192F]/90 text-white font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed mt-2"
                  >
                    {isLoading ? (
                      <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <>Se connecter <ArrowRight className="w-4 h-4" /></>
                    )}
                  </button>
                </form>
              )}

              {/* PHONE form */}
              {method === "phone" && (
                <form onSubmit={handlePhoneSubmit} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-[#0A192F] mb-1.5">
                      Numéro de téléphone
                    </label>
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
                        className="flex-1 h-12 px-4 rounded-xl border border-slate-200 bg-white text-[#0A192F] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0A192F]/10 focus:border-[#0A192F] transition-all"
                      />
                    </div>
                    <p className="text-xs text-slate-400 mt-1.5">
                      Un code SMS vous sera envoyé pour confirmer.
                    </p>
                  </div>

                  {error && (
                    <div className="p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full h-12 rounded-xl bg-[#0A192F] hover:bg-[#0A192F]/90 text-white font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isLoading ? (
                      <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <>
                        <Phone className="w-4 h-4" /> Recevoir le code SMS <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </form>
              )}

              <p className="mt-6 text-center text-sm text-slate-500">
                Pas encore de compte ?{" "}
                <Link href="/register" className="font-semibold text-[#0A192F] hover:text-[#D4AF37] transition-colors">
                  Créer un dossier
                </Link>
              </p>
            </>
          ) : (
            /* OTP Step */
            <>
              <div className="mb-8">
                <div className="w-14 h-14 rounded-2xl bg-[#D4AF37]/10 flex items-center justify-center mb-4">
                  {method === "phone"
                    ? <Phone className="w-7 h-7 text-[#D4AF37]" />
                    : <Mail className="w-7 h-7 text-[#D4AF37]" />
                  }
                </div>
                <h2 className="text-3xl font-serif font-bold text-[#0A192F]">Vérification</h2>
                <p className="mt-2 text-slate-500">
                  Un code à 6 chiffres a été envoyé{" "}
                  {method === "phone"
                    ? <>par SMS au <span className="font-semibold text-[#0A192F]">{identifier}</span></>
                    : <>à <span className="font-semibold text-[#0A192F]">{identifier}</span></>
                  }
                </p>
              </div>

              <form onSubmit={handleOtpVerify} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-[#0A192F] mb-1.5">
                    Code de vérification
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    maxLength={6}
                    required
                    autoFocus
                    className="w-full h-14 px-4 rounded-xl border border-slate-200 bg-white text-[#0A192F] text-center text-2xl font-mono tracking-[0.5em] placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0A192F]/10 focus:border-[#0A192F] transition-all"
                  />
                </div>

                {error && (
                  <div className="p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading || otpCode.length < 6}
                  className="w-full h-12 rounded-xl bg-[#0A192F] hover:bg-[#0A192F]/90 text-white font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isLoading ? (
                    <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <><CheckCircle2 className="w-4 h-4" /> Confirmer</>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => { setStep("credentials"); setOtpCode(""); setError(""); }}
                  className="w-full text-sm text-slate-500 hover:text-[#0A192F] transition-colors"
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
