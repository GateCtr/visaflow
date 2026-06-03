import { InvoiceDocument } from "@/components/InvoiceDocument";

interface InvoicePanelProps {
  app: any;
}

export function InvoicePanel({ app }: InvoicePanelProps) {
  const isReceipt = app.priceDetails?.isEngagementPaid;

  return (
    <div className="max-w-3xl">
      <InvoiceDocument app={app} type={isReceipt ? "recu" : "facture"} />
    </div>
  );
}
