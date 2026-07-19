import { MessageCircle } from "lucide-react";

const WHATSAPP_NUMBER = "243840808122";

interface WhatsAppAuditCTAProps {
  label?: string;
  message?: string;
  variant?: "solid" | "outline";
  size?: "md" | "lg";
  className?: string;
}

export function WhatsAppAuditCTA({
  label = "Faire analyser mon dossier sur WhatsApp",
  message = "Bonjour Joventy, je viens du site. Je prépare un dossier de visa et je souhaite commander un Audit & Diagnostic pour sécuriser ma demande.",
  variant = "solid",
  size = "md",
  className = "",
}: WhatsAppAuditCTAProps) {
  const whatsappUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

  const base =
    "inline-flex items-center justify-center gap-2.5 font-bold rounded-xl shadow-lg transition-all transform hover:-translate-y-0.5";
  const sizeCls = size === "lg" ? "px-8 py-4 text-base" : "px-6 py-3 text-sm";
  const variantCls =
    variant === "solid"
      ? "bg-green-600 hover:bg-green-500 text-white shadow-green-600/20"
      : "bg-white border-2 border-green-600 text-green-700 hover:bg-green-50";

  return (
    <a
      href={whatsappUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`${base} ${sizeCls} ${variantCls} ${className}`}
    >
      <MessageCircle className={size === "lg" ? "w-5 h-5" : "w-4 h-4"} />
      {label}
    </a>
  );
}
