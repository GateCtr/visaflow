import { AuthenticateWithRedirectCallback, useAuth } from "@clerk/react";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { JoventyLogo } from "@/components/JoventyLogo";

export default function SSOCallback() {
  const { isSignedIn, isLoaded } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoaded) return;
    // Already signed in → dashboard
    if (isSignedIn) { setLocation("/dashboard"); return; }
    // No OAuth params in URL (direct visit or stale URL) → login
    const hasParams = window.location.search.length > 1 || window.location.hash.length > 1;
    if (!hasParams) { setLocation("/login"); return; }
  }, [isLoaded, isSignedIn]);

  return (
    <>
      <AuthenticateWithRedirectCallback
        signInForceRedirectUrl="/dashboard"
        signUpForceRedirectUrl="/dashboard"
        continueSignUpUrl="/continue"
      />
      <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-6">
        <JoventyLogo variant="light" size="md" />
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
          <p className="text-text-secondary text-sm font-medium">Connexion en cours…</p>
        </div>
      </div>
    </>
  );
}
