import { useClerk, useAuth } from "@clerk/clerk-react";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { JoventyLogo } from "@/components/JoventyLogo";

export default function SSOCallback() {
  const { handleRedirectCallback, isLoaded } = useClerk();
  const { isSignedIn } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoaded) return;

    // Already signed in → go to dashboard immediately
    if (isSignedIn) {
      setLocation("/dashboard");
      return;
    }

    // No Clerk OAuth params in the URL → nothing to process, redirect to login
    const hasOAuthParams =
      window.location.search.includes("__clerk") ||
      window.location.hash.includes("__clerk") ||
      document.referrer.includes("clerk.accounts.dev") ||
      document.referrer.includes("accounts.clerk.dev");

    if (!hasOAuthParams) {
      setLocation("/login");
      return;
    }

    // Safety timeout – if Clerk doesn't redirect within 8s, fall back
    const timer = setTimeout(() => setLocation("/login"), 8000);

    handleRedirectCallback({
      afterSignInUrl: "/dashboard",
      afterSignUpUrl: "/dashboard",
      continueSignUpUrl: "/dashboard",
      firstFactorUrl: "/dashboard",
      secondFactorUrl: "/dashboard",
    })
      .then(() => clearTimeout(timer))
      .catch(() => {
        clearTimeout(timer);
        setLocation("/login");
      });

    return () => clearTimeout(timer);
  }, [isLoaded, isSignedIn]);

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
