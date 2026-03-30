import { useSignUp } from "@clerk/clerk-react";
import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { JoventyLogo } from "@/components/JoventyLogo";

function randomUsername() {
  return "user_" + Math.random().toString(36).slice(2, 10);
}

export default function ContinueSignUp() {
  const { signUp, isLoaded } = useSignUp();
  const [, setLocation] = useLocation();
  const attempted = useRef(false);

  useEffect(() => {
    if (!isLoaded || attempted.current) return;
    attempted.current = true;

    const run = async () => {
      try {
        if (!signUp || signUp.status !== "missing_requirements") {
          // Nothing to complete — let AuthProvider redirect, or go to dashboard
          setLocation("/dashboard");
          return;
        }

        const updates: Record<string, string> = {};
        const missing = signUp.missingFields ?? [];

        if (missing.includes("username")) {
          updates.username = randomUsername();
        }

        if (Object.keys(updates).length > 0) {
          await signUp.update(updates);
          // Session is now created by Clerk; AuthProvider will redirect to /dashboard
          // once isSignedIn becomes true. Nothing else needed.
        } else {
          // Fields missing that we can't auto-fill — send to login
          setLocation("/login");
        }
      } catch {
        setLocation("/login");
      }
    };

    run();
  }, [isLoaded]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-6">
      <JoventyLogo variant="light" size="md" />
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
        <p className="text-text-secondary text-sm font-medium">
          Finalisation du compte…
        </p>
      </div>
    </div>
  );
}
