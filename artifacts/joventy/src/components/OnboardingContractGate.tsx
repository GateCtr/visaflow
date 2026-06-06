import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useAuth } from "@/lib/auth";
import { ContractSignModal } from "@/components/ContractSignModal";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

interface OnboardingContractGateProps {
  children: ReactNode;
}

/**
 * Gate intelligent qui affiche le modal de contrat SEULEMENT si:
 * 1. L'utilisateur a terminé le onboarding
 * 2. L'utilisateur n'a pas encore signé le contrat
 * 
 * Cela permet au onboarding de s'afficher sans blocage pour les nouveaux utilisateurs.
 */
export function OnboardingContractGate({ children }: OnboardingContractGateProps) {
  const { user } = useAuth();
  const hasSigned = useQuery(api.contracts.hasSignedContract);
  const onboardingCompleted = useQuery(api.users.getOnboardingStatus);
  const [justSigned, setJustSigned] = useState(false);

  // Chargement
  if (hasSigned === undefined || onboardingCompleted === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
      </div>
    );
  }

  // Logique d'affichage du contrat:
  // - Si l'utilisateur a déjà signé: ne rien afficher
  // - Si l'utilisateur n'a PAS terminé le onboarding: ne pas afficher le contrat (laisser le onboarding s'afficher)
  // - Si l'utilisateur a terminé le onboarding MAIS n'a pas signé: afficher le contrat
  const mustSign = hasSigned === false && onboardingCompleted === true && !justSigned;

  return (
    <>
      {mustSign && (
        <ContractSignModal
          userName={user ? `${user.firstName} ${user.lastName}`.trim() : ""}
          onSigned={() => setJustSigned(true)}
        />
      )}
      <div
        className={mustSign ? "pointer-events-none select-none" : undefined}
        style={mustSign ? { filter: "blur(4px)", userSelect: "none" } : undefined}
      >
        {children}
      </div>
    </>
  );
}
