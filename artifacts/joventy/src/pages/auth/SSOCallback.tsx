import { AuthenticateWithRedirectCallback } from "@clerk/react";
import { JoventyLogo } from "@/components/JoventyLogo";

export default function SSOCallback() {
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
