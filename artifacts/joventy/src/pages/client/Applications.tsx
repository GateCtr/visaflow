import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import { Plane, ChevronRight, Plus, ArrowUpCircle, Loader2, AlertTriangle, CheckCircle2, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { SERVICE_PACKAGES } from "@convex/constants";

const FINAL_STATUSES = new Set([
  "slot_found_awaiting_success_fee",
  "completed",
  "rejected",
]);

// Destinations supportées par slot_only (miroir de constants.ts)
const SLOT_ONLY_DESTINATIONS = new Set(
  SERVICE_PACKAGES.slot_only.availableFor as readonly string[]
);

// ── Éligibilité upgrade dossier_only → créneau ────────────────────────────
function isCreneauUpgradeEligible(app: {
  servicePackage?: string;
  status: string;
  destination: string;
  priceDetails?: { isEngagementPaid?: boolean } | null;
}): boolean {
  if (app.servicePackage !== "dossier_only") return false;
  if (FINAL_STATUSES.has(app.status)) return false;
  if (app.priceDetails?.isEngagementPaid) return false; // acompte déjà versé
  return SLOT_ONLY_DESTINATIONS.has(app.destination);
}

function isMigrationEligible(app: {
  servicePackage?: string;
  status: string;
  slotUrgencyTier?: string;
  priceDetails?: { engagementFee?: number; isEngagementPaid?: boolean; isSuccessFeePaid?: boolean } | null;
}): boolean {
  if (app.servicePackage !== "slot_only") return false;
  if (FINAL_STATUSES.has(app.status)) return false;
  // Prime de succès déjà réglée = état financier final, pas de migration
  if (app.priceDetails?.isSuccessFeePaid) return false;
  // Éligible si le tier n'est pas "standard" ou si l'acompte n'est pas $60
  const tierNotStandard = app.slotUrgencyTier !== "standard";
  const feeNotPromo = (app.priceDetails?.engagementFee ?? 0) !== 60;
  return tierNotStandard || feeNotPromo;
}

function MigrationBanner({ appId, applicantName, destination, isEngagementPaid, engagementFee, onDone }: {
  appId: Id<"applications">;
  applicantName: string;
  destination: string;
  isEngagementPaid: boolean;
  engagementFee: number;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const migrate = useMutation(api.applications.migrateToNewSlotSystem);
  const [isPending, setIsPending] = useState(false);
  const [done, setDone] = useState(false);

  // Messaging conditionnel selon l'état du paiement de l'acompte
  const afterMigrateDescription = isEngagementPaid
    ? `Acompte versé ($${engagementFee}) conservé · Solde ajusté à $90.`
    : "Nouveau tarif promo appliqué : $60 acompte / $90 solde (total $150).";

  const handleMigrate = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsPending(true);
    try {
      await migrate({ applicationId: appId });
      setDone(true);
      toast({ title: `${destination.toUpperCase()} — Dossier mis à jour !`, description: afterMigrateDescription });
      setTimeout(onDone, 1200);
    } catch (err) {
      toast({ variant: "destructive", title: "Erreur", description: "La migration a échoué. Réessayez ou contactez le support." });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-sm transition-all ${
      done ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-300"
    }`}>
      <div className="flex items-center gap-2 min-w-0">
        {done
          ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          : <ArrowUpCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />}
        <span className={done ? "text-emerald-800 font-medium" : "text-amber-900"}>
          <strong>{destination.toUpperCase()}</strong> — {applicantName}
          {done
            ? ` · Migré ✓ — ${afterMigrateDescription}`
            : isEngagementPaid
              ? " · Solde à normaliser ($90)"
              : " · Tarification ancienne ($60/$90/$150 dispo)"}
        </span>
      </div>
      {!done && (
        <Button
          size="sm"
          className="flex-shrink-0 bg-amber-600 hover:bg-amber-700 text-white gap-1.5 text-xs h-8"
          disabled={isPending}
          onClick={handleMigrate}
        >
          {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUpCircle className="w-3 h-3" />}
          Migrer
        </Button>
      )}
    </div>
  );
}

function CreneauUpgradeBanner({ appId, applicantName, destination, onDone }: {
  appId: Id<"applications">;
  applicantName: string;
  destination: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const migrate = useMutation(api.applications.migrateToCreneau);
  const [isPending, setIsPending] = useState(false);
  const [done, setDone] = useState(false);

  const handleUpgrade = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsPending(true);
    try {
      await migrate({ applicationId: appId });
      setDone(true);
      toast({ title: `${destination.toUpperCase()} — Service mis à niveau !`, description: "Votre dossier est maintenant en mode Créneau Uniquement. Acompte : $60 / Solde : $90 (total $150)." });
      setTimeout(onDone, 1400);
    } catch (err) {
      toast({ variant: "destructive", title: "Erreur", description: "La mise à niveau a échoué. Réessayez ou contactez le support." });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-sm transition-all ${
      done ? "bg-emerald-50 border-emerald-200" : "bg-blue-50 border-blue-300"
    }`}>
      <div className="flex items-center gap-2 min-w-0">
        {done
          ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          : <Calendar className="w-4 h-4 text-blue-600 flex-shrink-0" />}
        <span className={done ? "text-emerald-800 font-medium" : "text-blue-900"}>
          <strong>{destination.toUpperCase()}</strong> — {applicantName}
          {done ? " · Mis à niveau vers Créneau ✓" : " · Passer au service Créneau Uniquement ($60/$90/$150)"}
        </span>
      </div>
      {!done && (
        <Button
          size="sm"
          className="flex-shrink-0 bg-blue-600 hover:bg-blue-700 text-white gap-1.5 text-xs h-8"
          disabled={isPending}
          onClick={handleUpgrade}
        >
          {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Calendar className="w-3 h-3" />}
          Activer Créneau
        </Button>
      )}
    </div>
  );
}

export default function ClientApplications() {
  const applications = useQuery(api.applications.list, {}) ?? [];
  const isLoading = applications === undefined;
  const [migratedIds, setMigratedIds] = useState<Set<string>>(new Set());
  const [upgradedIds, setUpgradedIds] = useState<Set<string>>(new Set());

  const eligibleApps = applications.filter(
    (a) => !migratedIds.has(a._id) && isMigrationEligible(a as Parameters<typeof isMigrationEligible>[0])
  );
  const upgradeEligibleApps = applications.filter(
    (a) => !upgradedIds.has(a._id) && isCreneauUpgradeEligible(a as Parameters<typeof isCreneauUpgradeEligible>[0])
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-3xl font-serif font-bold text-primary">Mes Dossiers</h1>
        <div className="flex gap-2">
          <Link href="/dashboard/applications/new/creneau">
            <Button className="gap-2">
              <Plus className="w-4 h-4" /> Créneau
            </Button>
          </Link>
          <Link href="/dashboard/applications/new">
            <Button variant="outline" className="gap-2">
              <Plus className="w-4 h-4" /> Visa
            </Button>
          </Link>
        </div>
      </div>

      {/* Bannière migration — dossiers créneaux ancienne tarification */}
      {eligibleApps.length > 0 && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-5 space-y-3 shadow-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-amber-900 text-sm">Mise à jour du système de créneaux</p>
              <p className="text-xs text-amber-800 mt-0.5">
                Joventy a simplifié son système de créneaux avec une nouvelle tarification promo ($60 acompte / $90 solde).
                Vos dossiers ci-dessous utilisent l'ancienne tarification — migrez-les en un clic pour bénéficier du nouveau tarif.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            {eligibleApps.map((app) => (
              <MigrationBanner
                key={app._id}
                appId={app._id as Id<"applications">}
                applicantName={app.applicantName}
                destination={app.destination}
                isEngagementPaid={app.priceDetails?.isEngagementPaid ?? false}
                engagementFee={app.priceDetails?.engagementFee ?? 0}
                onDone={() => setMigratedIds((prev) => new Set([...prev, app._id]))}
              />
            ))}
          </div>
        </div>
      )}

      {/* Bannière upgrade — dossiers formulaire éligibles au service créneau */}
      {upgradeEligibleApps.length > 0 && (
        <div className="bg-blue-50 border-2 border-blue-300 rounded-2xl p-5 space-y-3 shadow-sm">
          <div className="flex items-start gap-3">
            <Calendar className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-blue-900 text-sm">Passez au service Créneau Uniquement</p>
              <p className="text-xs text-blue-800 mt-0.5">
                Votre formulaire est prêt — laissez Joventy s'occuper uniquement de la recherche de créneau.
                Tarif promo : <strong>$60 acompte / $90 solde (total $150)</strong>.
                Cette option est disponible pour vos dossiers ci-dessous.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            {upgradeEligibleApps.map((app) => (
              <CreneauUpgradeBanner
                key={app._id}
                appId={app._id as Id<"applications">}
                applicantName={app.applicantName}
                destination={app.destination}
                onDone={() => setUpgradedIds((prev) => new Set([...prev, app._id]))}
              />
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Chargement...</div>
      ) : applications.length === 0 ? (
        <div className="bg-card border border-border rounded-2xl p-12 text-center shadow-premium">
          <p className="text-lg text-muted-foreground mb-4">Aucun dossier trouvé.</p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center">
            <Link href="/dashboard/applications/new/creneau">
              <Button>Demande de créneau</Button>
            </Link>
            <Link href="/dashboard/applications/new">
              <Button variant="outline">Demande de visa</Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {applications.map((app) => (
            <Link key={app._id} href={`/dashboard/applications/${app._id}`}>
              <div className="bg-card rounded-2xl border border-border p-6 shadow-premium hover-lift cursor-pointer flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/5 flex items-center justify-center border border-primary/10">
                    <Plane className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-primary flex items-center gap-2">
                      Destination : {app.destination.toUpperCase()}
                    </h3>
                    <p className="text-muted-foreground text-sm">
                      {app.visaType} • Demandeur : {app.applicantName}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
                  <div className="text-right sm:pr-4 sm:border-r border-border">
                    <p className="text-xs text-muted-foreground mb-1">Mise à jour</p>
                    <p className="text-sm font-medium">{formatDate(app.updatedAt)}</p>
                  </div>
                  <StatusBadge status={app.status} />
                  <ChevronRight className="w-5 h-5 text-slate-300 hidden sm:block" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
