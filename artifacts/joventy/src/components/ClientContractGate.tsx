import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useAuth } from "@/lib/auth";
import { ContractSignModal } from "@/components/ContractSignModal";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

interface ClientContractGateProps {
  children: ReactNode;
}

export function ClientContractGate({ children }: ClientContractGateProps) {
  const { user } = useAuth();
  const hasSigned = useQuery(api.contracts.hasSignedContract);
  const [justSigned, setJustSigned] = useState(false);

  if (hasSigned === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
      </div>
    );
  }

  const mustSign = hasSigned === false && !justSigned;

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
