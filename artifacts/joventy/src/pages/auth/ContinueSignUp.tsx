import { useSignUp } from "@clerk/react";
import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { JoventyLogo } from "@/components/JoventyLogo";

function randomUsername() {
  return "user_" + Math.random().toString(36).slice(2, 10);
}

export default function ContinueSignUp() {
  const { signUp } = useSignUp();
  const [, setLocation] = useLocation();
  const attempted = useRef(false);

  useEffect(() => {
    if (!signUp || attempted.current) return;
    attempted.current = true;

    const run = async () => {
      try {
        if (signUp.status !== "missing_requirements") {
          setLocation("/dashboard");
          return;
        }

        const updates: Record<string, string> = {};
        const missing = signUp.missingFields ?? [];

        if (missing.includes("username")) {
          updates.username = randomUsername();
        }

        if (Object.keys(updates).length > 0) {
          const { error } = await signUp.update(updates);
          if (error) {
            setLocation("/login");
            return;
          }
          await signUp.finalize();
          setLocation("/dashboard");
        } else {
          setLocation("/login");
        }
      } catch {
        setLocation("/login");
      }
    };

    run();
  }, [signUp?.status]);

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
