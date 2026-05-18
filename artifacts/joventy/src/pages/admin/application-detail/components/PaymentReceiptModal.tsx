/**
 * Modal preview pour les reçus de paiement.
 */

export function PaymentReceiptModal({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="relative max-w-2xl w-full bg-white rounded-2xl overflow-hidden shadow-2xl ring-1 ring-black/5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-100 flex justify-between items-center bg-slate-50/80">
          <span className="text-sm font-semibold text-slate-800">Reçu de paiement</span>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-all"
          >
            ✕
          </button>
        </div>
        <img
          src={url}
          alt="Reçu de paiement"
          className="w-full max-h-[70vh] object-contain"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
            (e.currentTarget.nextElementSibling as HTMLElement).style.display = "block";
          }}
        />
        <p className="hidden p-6 text-center text-sm text-slate-500">
          Le fichier ne peut pas être prévisualisé.{" "}
          <a href={url} target="_blank" rel="noreferrer" className="text-blue-600 underline font-medium">
            Ouvrir dans un nouvel onglet
          </a>
        </p>
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end bg-slate-50/50">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
          >
            Ouvrir dans un nouvel onglet →
          </a>
        </div>
      </div>
    </div>
  );
}
