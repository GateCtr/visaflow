import { useSignUp, useAuth } from "@clerk/react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { JoventyLogo } from "@/components/JoventyLogo";
import { CheckCircle2, XCircle, AlertCircle, Phone, ArrowRight } from "lucide-react";

function randomUsername() {
  return "user_" + Math.random().toString(36).slice(2, 10);
}

type Phase = "loading" | "phone" | "otp" | "done" | "error";

export default function ContinueSignUp() {
  const { signUp } = useSignUp();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const [, setLocation] = useLocation();
  const attempted = useRef(false);

  const [phase, setPhase] = useState<Phase>("loading");
  const [statusMsg, setStatusMsg] = useState("Finalisation du compte…");
  const [clerkError, setClerkError] = useState<string | null>(null);

  const [phoneDigits, setPhoneDigits] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState("");

  /* ---- initial resolution ---- */
  useEffect(() => {
    if (!authLoaded) return;

    if (isSignedIn) {
      setPhase("done");
      setLocation("/dashboard");
      return;
    }

    if (!signUp || attempted.current) return;
    attempted.current = true;

    const run = async () => {
      try {
        console.log("[ContinueSignUp] status:", signUp.status, "| missing:", signUp.missingFields);

        if (signUp.status === "complete") {
          setPhase("done");
          setLocation("/dashboard");
          return;
        }

        if (signUp.status !== "missing_requirements") {
          setPhase("error");
          setStatusMsg("Session expirée. Veuillez recommencer.");
          setClerkError(`Status : ${signUp.status ?? "null"}`);
          return;
        }

        const missing = signUp.missingFields ?? [];

        if (missing.length === 0) {
          setPhase("done");
          setLocation("/dashboard");
          return;
        }

        // Auto-fill non-interactive fields
        const autoUpdates: Record<string, unknown> = {};
        if (missing.includes("username"))       autoUpdates.username = randomUsername();
        if (missing.includes("legal_accepted"))  autoUpdates.legalAccepted = true;
        if (missing.includes("first_name"))      autoUpdates.firstName = "Utilisateur";
        if (missing.includes("last_name"))       autoUpdates.lastName = "Joventy";

        if (Object.keys(autoUpdates).length > 0) {
          const { error } = await signUp.update(autoUpdates as Parameters<typeof signUp.update>[0]);
          if (error) {
            setPhase("error");
            setClerkError(error.longMessage || error.message);
            setStatusMsg("Erreur de mise à jour");
            return;
          }
        }

        if (missing.includes("phone_number")) {
          setPhase("phone");
          return;
        }

        // Unhandled fields
        const known = ["username", "legal_accepted", "first_name", "last_name", "phone_number"];
        const unhandled = missing.filter((f) => !known.includes(f));
        if (unhandled.length > 0) {
          setPhase("error");
          setClerkError(
            `Champs requis non gérés : ${unhandled.join(", ")}. ` +
            `Désactivez-les dans Clerk Dashboard → User & Authentication → Sign-up settings.`
          );
          setStatusMsg("Configuration Clerk requise");
          return;
        }

        setPhase("done");
        setLocation("/dashboard");
      } catch (e: unknown) {
        setPhase("error");
        setClerkError(e instanceof Error ? e.message : String(e));
        setStatusMsg("Erreur inattendue");
      }
    };

    run();
  }, [authLoaded, isSignedIn, signUp?.status]);

  /* ---- phone submit → send OTP ---- */
  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signUp || !phoneDigits) return;
    setFieldError("");
    setIsSubmitting(true);
    const fullPhone = `+243${phoneDigits.replace(/\D/g, "")}`;
    try {
      const { error } = await signUp.update(
        { phoneNumber: fullPhone } as Parameters<typeof signUp.update>[0]
      );
      if (error) { setFieldError(error.longMessage || error.message); return; }

      const { error: sendErr } = await signUp.verifications.sendPhoneCode();
      if (sendErr) { setFieldError(sendErr.longMessage || sendErr.message); return; }

      setPhase("otp");
    } catch (e: unknown) {
      setFieldError(e instanceof Error ? e.message : "Erreur inconnue");
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ---- OTP submit → verify + complete ---- */
  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signUp || !otpCode) return;
    setFieldError("");
    setIsSubmitting(true);
    try {
      const { error } = await signUp.verifications.verifyPhoneCode({ code: otpCode });
      if (error) { setFieldError(error.longMessage || error.message); return; }

      // After verification, session is auto-created if all requirements met
      setPhase("done");
      setLocation("/dashboard");
    } catch (e: unknown) {
      setFieldError(e instanceof Error ? e.message : "Code invalide");
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ---- render ---- */
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm flex flex-col items-center gap-6">
        <JoventyLogo variant="sidebar" size="md" />

        {/* LOADING */}
        {phase === "loading" && (
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
            <p className="text-sm font-medium text-slate-600">{statusMsg}</p>
          </div>
        )}

        {/* DONE */}
        {phase === "done" && (
          <div className="flex flex-col items-center gap-3">
            <CheckCircle2 className="w-10 h-10 text-green-500" />
            <p className="text-sm font-semibold text-green-600">Compte activé !</p>
          </div>
        )}

        {/* PHONE FORM */}
        {phase === "phone" && (
          <div className="w-full">
            <div className="text-center mb-6">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Phone className="w-7 h-7 text-primary" />
              </div>
              <h2 className="text-xl font-bold text-primary">Numéro de téléphone requis</h2>
              <p className="text-sm text-slate-500 mt-1">
                Google ne partage pas votre téléphone.<br />
                Ajoutez-le pour finaliser votre compte.
              </p>
            </div>
            <form onSubmit={handlePhoneSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-primary mb-1.5">Numéro de téléphone</label>
                <div className="flex gap-2">
                  <span className="flex items-center h-12 px-3 rounded-xl border border-slate-200 bg-white text-slate-500 text-sm font-medium whitespace-nowrap">
                    🇨🇩 +243
                  </span>
                  <input
                    type="tel"
                    value={phoneDigits}
                    onChange={(e) => setPhoneDigits(e.target.value.replace(/\D/g, ""))}
                    placeholder="8X XXX XXXX"
                    required
                    className="flex-1 h-12 px-4 rounded-xl border border-slate-200 bg-white text-primary placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary transition-all"
                  />
                </div>
                <p className="text-xs text-slate-400 mt-1.5">
                  Conseil : rendez ce champ optionnel dans Clerk Dashboard si non nécessaire.
                </p>
              </div>
              {fieldError && <div className="p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm">{fieldError}</div>}
              <button
                type="submit"
                disabled={isSubmitting || !phoneDigits}
                className="w-full h-12 rounded-xl bg-primary hover:bg-primary/90 text-white font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isSubmitting
                  ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  : <>Recevoir le code SMS <ArrowRight className="w-4 h-4" /></>}
              </button>
            </form>
          </div>
        )}

        {/* OTP FORM */}
        {phase === "otp" && (
          <div className="w-full">
            <div className="text-center mb-6">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Phone className="w-7 h-7 text-primary" />
              </div>
              <h2 className="text-xl font-bold text-primary">Vérification SMS</h2>
              <p className="text-sm text-slate-500 mt-1">
                Un code à 6 chiffres a été envoyé au<br />
                <span className="font-semibold text-primary">+243 {phoneDigits}</span>
              </p>
            </div>
            <form onSubmit={handleOtpSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-primary mb-1.5">Code de vérification</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  required
                  className="w-full h-12 px-4 rounded-xl border border-slate-200 bg-white text-primary text-center text-xl font-mono tracking-[0.5em] placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary transition-all"
                />
              </div>
              {fieldError && <div className="p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm">{fieldError}</div>}
              <button
                type="submit"
                disabled={isSubmitting || otpCode.length < 6}
                className="w-full h-12 rounded-xl bg-primary hover:bg-primary/90 text-white font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isSubmitting
                  ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  : <>Confirmer <ArrowRight className="w-4 h-4" /></>}
              </button>
              <button
                type="button"
                onClick={() => { setPhase("phone"); setOtpCode(""); setFieldError(""); }}
                className="w-full text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                Changer de numéro
              </button>
            </form>
          </div>
        )}

        {/* ERROR */}
        {phase === "error" && (
          <div className="flex flex-col items-center gap-4 w-full">
            <XCircle className="w-10 h-10 text-red-500" />
            <p className="text-sm font-semibold text-red-600">{statusMsg}</p>
            {clerkError && (
              <div className="w-full flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-100 text-left">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-red-600 break-words">{clerkError}</p>
              </div>
            )}
            <div className="flex gap-3 w-full">
              <button
                onClick={() => setLocation("/register")}
                className="flex-1 h-10 rounded-xl border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 transition-all"
              >
                Réessayer
              </button>
              <button
                onClick={() => setLocation("/login")}
                className="flex-1 h-10 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-all"
              >
                Se connecter
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
