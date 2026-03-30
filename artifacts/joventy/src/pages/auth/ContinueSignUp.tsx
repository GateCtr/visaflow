import { useSignUp, useAuth } from "@clerk/react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { JoventyLogo } from "@/components/JoventyLogo";
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";

function randomUsername() {
  return "user_" + Math.random().toString(36).slice(2, 10);
}

export default function ContinueSignUp() {
  const { signUp } = useSignUp();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const [, setLocation] = useLocation();
  const attempted = useRef(false);
  const [statusMsg, setStatusMsg] = useState("Finalisation du compte…");
  const [clerkError, setClerkError] = useState<string | null>(null);
  const [missingDebug, setMissingDebug] = useState<string[]>([]);
  const [hasError, setHasError] = useState(false);
  const [isDone, setIsDone] = useState(false);

  useEffect(() => {
    if (!authLoaded) return;

    // Already authenticated → dashboard directly
    if (isSignedIn) {
      setIsDone(true);
      setStatusMsg("Compte activé !");
      setLocation("/dashboard");
      return;
    }

    if (!signUp || attempted.current) return;
    attempted.current = true;

    const run = async () => {
      try {
        console.log("[ContinueSignUp] status:", signUp.status, "| missing:", signUp.missingFields);

        if (signUp.status === "complete") {
          // Session already created by OAuth callback — go to dashboard
          setIsDone(true);
          setStatusMsg("Compte activé !");
          setLocation("/dashboard");
          return;
        }

        if (signUp.status !== "missing_requirements") {
          console.warn("[ContinueSignUp] unexpected status:", signUp.status);
          setHasError(true);
          setStatusMsg("Session expirée. Veuillez réessayer.");
          setClerkError(`Status reçu : ${signUp.status ?? "null"}`);
          return;
        }

        const missing = signUp.missingFields ?? [];
        setMissingDebug(missing);

        // No missing fields at all → OAuth session already created, go to dashboard
        if (missing.length === 0) {
          setIsDone(true);
          setStatusMsg("Compte activé !");
          setLocation("/dashboard");
          return;
        }

        // Handle auto-fillable missing fields
        const updates: Record<string, unknown> = {};
        if (missing.includes("username"))       updates.username = randomUsername();
        if (missing.includes("legal_accepted"))  updates.legalAccepted = true;
        if (missing.includes("first_name"))      updates.firstName = "Utilisateur";
        if (missing.includes("last_name"))       updates.lastName = "Joventy";

        const unhandled = missing.filter(
          (f) => !["username", "legal_accepted", "first_name", "last_name"].includes(f)
        );

        if (Object.keys(updates).length > 0) {
          setStatusMsg("Mise à jour du profil…");
          const { error: updateErr } = await signUp.update(
            updates as Parameters<typeof signUp.update>[0]
          );
          if (updateErr) {
            console.error("[ContinueSignUp] update error:", updateErr);
            setHasError(true);
            setClerkError(updateErr.longMessage || updateErr.message);
            setStatusMsg("Erreur de mise à jour");
            return;
          }
        }

        if (unhandled.length > 0) {
          console.warn("[ContinueSignUp] unhandled missing fields:", unhandled);
          setHasError(true);
          setMissingDebug(unhandled);
          setStatusMsg("Configuration requise dans Clerk Dashboard");
          setClerkError(
            `Champs non gérés : ${unhandled.join(", ")}. Désactivez-les dans Clerk Dashboard → User & Authentication.`
          );
          return;
        }

        // Fallback: still missing_requirements but nothing left to do
        setIsDone(true);
        setStatusMsg("Compte activé !");
        setLocation("/dashboard");

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[ContinueSignUp] unexpected error:", e);
        setHasError(true);
        setClerkError(msg);
        setStatusMsg("Erreur inattendue");
      }
    };

    run();
  }, [authLoaded, isSignedIn, signUp?.status]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-6 px-4">
      <JoventyLogo variant="sidebar" size="md" />
      <div className="flex flex-col items-center gap-4 text-center max-w-sm w-full">
        {hasError ? (
          <XCircle className="w-10 h-10 text-red-500" />
        ) : isDone ? (
          <CheckCircle2 className="w-10 h-10 text-green-500" />
        ) : (
          <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
        )}

        <p className={`text-sm font-semibold ${hasError ? "text-red-600" : isDone ? "text-green-600" : "text-slate-700"}`}>
          {statusMsg}
        </p>

        {clerkError && (
          <div className="w-full flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-100 text-left">
            <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-red-700">Détail de l'erreur :</p>
              <p className="text-xs text-red-600 mt-0.5 break-words">{clerkError}</p>
            </div>
          </div>
        )}

        {missingDebug.length > 0 && hasError && (
          <div className="w-full flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-100 text-left">
            <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-amber-700">Champs manquants :</p>
              <p className="text-xs text-amber-600 mt-0.5">{missingDebug.join(", ")}</p>
            </div>
          </div>
        )}

        {hasError && (
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
        )}
      </div>
    </div>
  );
}
