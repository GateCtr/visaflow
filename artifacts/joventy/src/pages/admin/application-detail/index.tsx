/**
 * ApplicationDetail — Page admin détail dossier (version modulaire).
 *
 * Layout épuré 2 colonnes (contenu scrollable + chat sticky).
 * Chaque section est un module indépendant avec son propre state.
 */
import { useRoute } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { VISA_PRICING } from "@convex/constants";
import { Loader2 } from "lucide-react";

import { HeaderCard } from "./HeaderCard";
import { PaymentPanel } from "./PaymentPanel";
import { QuickActions } from "./QuickActions";
import { SlotPanel } from "./SlotPanel";
import { EvisaPanel } from "./EvisaPanel";
import { HunterConfig } from "./HunterConfig";
import { DocumentVault } from "./DocumentVault";
import { ActivityLog } from "./ActivityLog";
import { BotLogTimeline } from "./BotLogTimeline";
import { ChatPanel } from "./ChatPanel";

export default function ApplicationDetailPage() {
  const [, params] = useRoute("/admin/applications/:id");
  const appId = params?.id as Id<"applications"> | undefined;

  const app = useQuery(api.applications.get, appId ? { id: appId } : "skip");
  const messages = useQuery(api.messages.list, appId ? { applicationId: appId } : "skip") ?? [];
  const proofUrls = useQuery(api.documents.getPaymentProofUrls, appId ? { applicationId: appId } : "skip");
  const docs = useQuery(api.documents.listByApplication, appId ? { applicationId: appId } : "skip") ?? [];
  const botLogs = useQuery(api.botLogs.listByApplication, appId ? { applicationId: appId } : "skip") ?? [];
  const confirmationLetterUrl = useQuery(api.documents.getConfirmationLetterUrl, appId ? { applicationId: appId } : "skip");

  // Loading
  if (app === undefined) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        <span className="ml-3 text-sm text-slate-500">Chargement du dossier...</span>
      </div>
    );
  }
  if (!app) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-sm text-red-500 font-medium">Dossier introuvable</p>
      </div>
    );
  }

  // Derived state
  const pricing = VISA_PRICING[app.destination as keyof typeof VISA_PRICING];
  const isEngagementPaid = app.priceDetails?.isEngagementPaid ?? false;
  const isSuccessFeePaid = app.priceDetails?.isSuccessFeePaid ?? false;
  const hasEngagementProof = !!app.paymentProofUrl;
  const hasSuccessProof = !!app.successFeeProofUrl;
  const isSlotHunting = app.status === "slot_hunting";
  const isSlotFound = app.status === "slot_found_awaiting_success_fee";
  const isCompleted = app.status === "completed";
  const isRejected = app.status === "rejected";
  const successModel = (app as { successModel?: string }).successModel ?? pricing?.successModel ?? "appointment";
  const isEvisaModel = successModel === "evisa";
  const servicePackage = (app as { servicePackage?: string }).servicePackage ?? "full_service";
  const isDossierOnly = servicePackage === "dossier_only";
  const isSlotOnly = servicePackage === "slot_only";
  const urgencyTierKey = (app as { slotUrgencyTier?: string }).slotUrgencyTier as any;
  const hunterConfig = (app as { hunterConfig?: any }).hunterConfig ?? null;

  return (
    <div className="h-full flex flex-col xl:flex-row gap-6 xl:gap-8">
      {/* ═══ LEFT — Main content (scrollable) ═══ */}
      <div className="w-full xl:w-2/3 2xl:w-[70%] space-y-6">

        {/* Header */}
        <HeaderCard
          app={app as any}
          servicePackage={servicePackage}
          isDossierOnly={isDossierOnly}
          isSlotOnly={isSlotOnly}
        />

        {/* Payments */}
        <PaymentPanel
          appId={appId!}
          priceDetails={app.priceDetails as any}
          isEngagementPaid={isEngagementPaid}
          isSuccessFeePaid={isSuccessFeePaid}
          hasEngagementProof={hasEngagementProof}
          hasSuccessProof={hasSuccessProof}
          engagementProofUrl={proofUrls?.engagementUrl}
          successFeeProofUrl={proofUrls?.successFeeUrl}
          isDossierOnly={isDossierOnly}
          isSlotOnly={isSlotOnly}
          urgencyTierKey={urgencyTierKey}
        />

        {/* Quick Actions */}
        {!isCompleted && !isRejected && (
          <QuickActions
            appId={appId!}
            status={app.status}
            isEngagementPaid={isEngagementPaid}
            isDossierOnly={isDossierOnly}
            isSlotOnly={isSlotOnly}
            isCompleted={isCompleted}
            adminNotes={app.adminNotes ?? ""}
          />
        )}

        {/* Slot Panel (appointment model) */}
        {!isEvisaModel && (isSlotHunting || isSlotFound || (isCompleted && app.appointmentDetails)) && (
          <SlotPanel
            appId={appId!}
            isSlotHunting={isSlotHunting}
            isSlotFound={isSlotFound}
            isCompleted={isCompleted}
            appointmentDetails={app.appointmentDetails as any}
            slotExpiresAt={(app as any).slotExpiresAt}
            confirmationLetterUrl={confirmationLetterUrl}
            defaultLocation={pricing?.embassyAddress}
          />
        )}

        {/* E-Visa Panel */}
        {isEvisaModel && (isSlotHunting || isSlotFound) && !isCompleted && (
          <EvisaPanel appId={appId!} isSlotFound={isSlotFound} isSlotHunting={isSlotHunting} />
        )}

        {/* Hunter Config */}
        {isSlotOnly && isSlotHunting && (
          <HunterConfig
            appId={appId!}
            hunterConfig={hunterConfig}
            destination={app.destination}
            broadcastVisaClass={(app as { broadcastVisaClass?: string }).broadcastVisaClass ?? null}
            usVisaCode={(app as { usVisaCode?: string }).usVisaCode ?? null}
            usVisaCategory={(app as { usVisaCategory?: string }).usVisaCategory ?? null}
          />
        )}

        {/* Documents */}
        {pricing && isEngagementPaid && (
          <DocumentVault
            appId={appId!}
            destination={app.destination}
            visaType={app.visaType}
            servicePackage={servicePackage}
            docs={docs as any}
          />
        )}

        {/* Activity Log */}
        <ActivityLog logs={(app.logs ?? []) as any} />

        {/* Bot Logs */}
        <BotLogTimeline appId={appId!} botLogs={botLogs as any} />
      </div>

      {/* ═══ RIGHT — Chat (sticky) ═══ */}
      <div className="w-full xl:w-1/3 2xl:w-[30%]">
        <ChatPanel
          appId={appId!}
          messages={messages as any}
          firstName={app.userFirstName}
          lastName={app.userLastName}
        />
      </div>
    </div>
  );
}
