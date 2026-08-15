/**
 * ApplicationDetail — Page admin détail dossier.
 *
 * Layout moderne pro : header compact + onglets + panneau chat rétractable.
 * Inspiré des apps type Linear / Notion / Intercom.
 */
import { useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { VISA_PRICING } from "@convex/constants";
import {
  Loader2, CreditCard, Zap, FileText, Clock, Bot,
  Calendar, MessageSquare, X, ChevronRight,
} from "lucide-react";

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
import { InvoicePanel } from "./InvoicePanel";
import { Receipt } from "lucide-react";

type Tab = "overview" | "documents" | "bot" | "activity" | "invoice";

const TAB_CONFIG: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "Aperçu", icon: <Zap className="w-3.5 h-3.5" /> },
  { id: "documents", label: "Documents", icon: <FileText className="w-3.5 h-3.5" /> },
  { id: "bot", label: "Bot & Slot", icon: <Bot className="w-3.5 h-3.5" /> },
  { id: "activity", label: "Activité", icon: <Clock className="w-3.5 h-3.5" /> },
  { id: "invoice", label: "Facture", icon: <Receipt className="w-3.5 h-3.5" /> },
];

export default function ApplicationDetailPage() {
  const [, params] = useRoute("/admin/applications/:id");
  const appId = params?.id as Id<"applications"> | undefined;

  const app = useQuery(api.applications.get, appId ? { id: appId } : "skip");
  const messages = useQuery(api.messages.list, appId ? { applicationId: appId } : "skip") ?? [];
  const proofUrls = useQuery(api.documents.getPaymentProofUrls, appId ? { applicationId: appId } : "skip");
  const docs = useQuery(api.documents.listByApplication, appId ? { applicationId: appId } : "skip") ?? [];
  const botLogs = useQuery(api.botLogs.listByApplication, appId ? { applicationId: appId } : "skip") ?? [];
  const confirmationLetterUrl = useQuery(api.documents.getConfirmationLetterUrl, appId ? { applicationId: appId } : "skip");

  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [chatOpen, setChatOpen] = useState(false);

  // Loading
  if (app === undefined) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        <span className="ml-2 text-sm text-slate-500">Chargement...</span>
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

  const unreadCount = messages.filter((m: any) => !m.isFromAdmin && !m.readByAdmin).length;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* ═══ HEADER COMPACT ═══ */}
      <HeaderCard
        app={app as any}
        servicePackage={servicePackage}
        isDossierOnly={isDossierOnly}
        isSlotOnly={isSlotOnly}
        isEvisaModel={isEvisaModel}
      />

      {/* ═══ TAB BAR + CHAT TOGGLE ═══ */}
      <div className="flex items-center border-b border-slate-200 bg-white px-4 lg:px-6 mt-4 rounded-t-xl">
        <nav className="flex gap-1 overflow-x-auto scrollbar-hide -mb-px flex-1">
          {TAB_CONFIG.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-all ${
                activeTab === tab.id
                  ? "border-blue-600 text-blue-700 bg-blue-50/50"
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50"
              }`}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </nav>

        {/* Chat toggle button */}
        <button
          onClick={() => setChatOpen((v) => !v)}
          className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg ml-2 transition-all ${
            chatOpen
              ? "bg-blue-600 text-white shadow-sm"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Chat</span>
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 text-[10px] font-bold bg-red-500 text-white rounded-full flex items-center justify-center">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </div>

      {/* ═══ MAIN CONTENT AREA ═══ */}
      <div className="flex-1 flex min-h-0 relative">
        {/* ─── TAB CONTENT ─── */}
        <div
          className={`flex-1 overflow-y-auto p-4 lg:p-6 space-y-4 transition-all ${
            chatOpen ? "lg:mr-[380px]" : ""
          }`}
        >
          {activeTab === "overview" && (
            <TabOverview
              appId={appId!}
              app={app}
              priceDetails={app.priceDetails as any}
              isEngagementPaid={isEngagementPaid}
              isSuccessFeePaid={isSuccessFeePaid}
              hasEngagementProof={hasEngagementProof}
              hasSuccessProof={hasSuccessProof}
              proofUrls={proofUrls}
              isDossierOnly={isDossierOnly}
              isSlotOnly={isSlotOnly}
              isCompleted={isCompleted}
              isRejected={isRejected}
              urgencyTierKey={urgencyTierKey}
            />
          )}
          {activeTab === "documents" && (
            <TabDocuments
              appId={appId!}
              destination={app.destination}
              visaType={app.visaType}
              servicePackage={servicePackage}
              docs={docs as any}
              pricing={pricing}
              isEngagementPaid={isEngagementPaid}
            />
          )}
          {activeTab === "bot" && (
            <TabBot
              appId={appId!}
              app={app}
              isSlotHunting={isSlotHunting}
              isSlotFound={isSlotFound}
              isCompleted={isCompleted}
              isEvisaModel={isEvisaModel}
              isSlotOnly={isSlotOnly}
              hunterConfig={hunterConfig}
              pricing={pricing}
              confirmationLetterUrl={confirmationLetterUrl}
              botLogs={botLogs as any}
            />
          )}
          {activeTab === "activity" && (
            <ActivityLog logs={(app.logs ?? []) as any} />
          )}
          {activeTab === "invoice" && (
            <InvoicePanel app={app} />
          )}
        </div>

        {/* ─── CHAT PANEL (Slide-over) ─── */}
        {chatOpen && (
          <>
            {/* Mobile overlay */}
            <div
              className="fixed inset-0 bg-black/20 z-40 lg:hidden"
              onClick={() => setChatOpen(false)}
            />
            <aside
              className={`
                fixed right-0 top-0 bottom-0 w-[85vw] max-w-[400px] z-50
                lg:absolute lg:top-0 lg:bottom-0 lg:right-0 lg:w-[380px] lg:z-10
                bg-white border-l border-slate-200 shadow-xl lg:shadow-md
                flex flex-col
              `}
            >
              {/* Close button (mobile) */}
              <button
                onClick={() => setChatOpen(false)}
                className="absolute top-3 right-3 lg:hidden w-7 h-7 flex items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 z-10"
              >
                <X className="w-4 h-4" />
              </button>
              <ChatPanel
                appId={appId!}
                messages={messages as any}
                firstName={app.userFirstName ?? ""}
                lastName={app.userLastName ?? ""}
              />
            </aside>
          </>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   TAB: Overview — Paiements + Actions rapides (side by side on large screens)
   ══════════════════════════════════════════════════════════════════════════════ */
function TabOverview({
  appId, app, priceDetails, isEngagementPaid, isSuccessFeePaid,
  hasEngagementProof, hasSuccessProof, proofUrls, isDossierOnly, isSlotOnly,
  isCompleted, isRejected, urgencyTierKey,
}: any) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {/* Payments */}
      <PaymentPanel
        appId={appId}
        priceDetails={priceDetails}
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
          appId={appId}
          status={app.status}
          isEngagementPaid={isEngagementPaid}
          isDossierOnly={isDossierOnly}
          isSlotOnly={isSlotOnly}
          isCompleted={isCompleted}
          adminNotes={app.adminNotes ?? ""}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   TAB: Documents
   ══════════════════════════════════════════════════════════════════════════════ */
function TabDocuments({ appId, destination, visaType, servicePackage, docs, pricing, isEngagementPaid }: any) {
  if (!pricing || !isEngagementPaid) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <FileText className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-sm font-medium">Documents disponibles après validation du paiement</p>
      </div>
    );
  }
  return (
    <DocumentVault
      appId={appId}
      destination={destination}
      visaType={visaType}
      servicePackage={servicePackage}
      docs={docs}
    />
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   TAB: Bot & Slot — SlotPanel, EvisaPanel, HunterConfig, BotLogTimeline
   ══════════════════════════════════════════════════════════════════════════════ */
function TabBot({
  appId, app, isSlotHunting, isSlotFound, isCompleted,
  isEvisaModel, isSlotOnly, hunterConfig, pricing, confirmationLetterUrl, botLogs,
}: any) {
  return (
    <div className="space-y-4">
      {/* Slot Panel (appointment model) */}
      {!isEvisaModel && (isSlotHunting || isSlotFound || (isCompleted && app.appointmentDetails)) && (
        <SlotPanel
          appId={appId}
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
        <EvisaPanel appId={appId} isSlotFound={isSlotFound} isSlotHunting={isSlotHunting} />
      )}

      {/* Hunter Config */}
      {(isSlotOnly || (app.destination === "schengen" && isSlotHunting)) && (
        <HunterConfig
          appId={appId}
          hunterConfig={hunterConfig}
          destination={app.destination}
          broadcastVisaClass={(app as { broadcastVisaClass?: string }).broadcastVisaClass ?? null}
          usVisaCode={(app as { usVisaCode?: string }).usVisaCode ?? null}
          usVisaCategory={(app as { usVisaCategory?: string }).usVisaCategory ?? null}
        />
      )}

      {/* Bot Logs */}
      <BotLogTimeline appId={appId} botLogs={botLogs} />

      {/* Empty state */}
      {!isSlotHunting && !isSlotFound && !isCompleted && botLogs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400">
          <Bot className="w-8 h-8 mb-2 opacity-50" />
          <p className="text-sm font-medium">Aucune activité bot pour ce dossier</p>
        </div>
      )}
    </div>
  );
}
