import { useClerk, useAuth } from "@clerk/clerk-react";
import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { JoventyLogo } from "@/components/JoventyLogo";

export default function SSOCallback() {
  const { handleRedirectCallback, isLoaded } = useClerk();
  const { isSignedIn } = useAuth();
  const [, setLocation] = useLocation();
  const navigated = useRef(false);

  function go(path: string) {
    if (navigated.current) return;
    navigated.current = true;
    setLocation(path);
  }

  // Primary path: as soon as Clerk marks session active → dashboard.
  // Fires regardless of whether handleRedirectCallback called routerReplace.
  useEffect(() => {
    if (isSignedIn) go("/dashboard");
  }, [isSignedIn]);

  // Secondary path: trigger the OAuth token exchange
  useEffect(() => {
    if (!isLoaded) return;

    // If already signed in on mount (e.g. page reload) → handled above
    if (isSignedIn) return;

    // Safety net: 10s max wait, then login
    const timer = setTimeout(() => go("/login"), 10000);

    handleRedirectCallback({
      afterSignInUrl: "/dashboard",
      afterSignUpUrl: "/dashboard",
      continueSignUpUrl: "/dashboard",
      firstFactorUrl: "/dashboard",
      secondFactorUrl: "/dashboard",
    })
      .then(() => {
        clearTimeout(timer);
        // If Clerk processed callback but isSignedIn watcher hasn't fired yet,
        // wait a tick for auth state to propagate then fall back to login
        setTimeout(() => go("/login"), 800);
      })
      .catch(() => {
        clearTimeout(timer);
        go("/login");
      });

    return () => clearTimeout(timer);
  }, [isLoaded]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-6">
      <JoventyLogo variant="light" size="md" />
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
        <p className="text-text-secondary text-sm font-medium">
          Connexion en cours…
        </p>
      </div>
    </div>
  );
}
