import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";
import {
  Star, CheckCircle2, XCircle, Trash2, MessageSquareHeart, Eye, EyeOff,
} from "lucide-react";

export default function AdminReviews() {
  const { toast } = useToast();
  const reviews = useQuery(api.reviews.listAll);
  const approve = useMutation(api.reviews.approve);
  const reject = useMutation(api.reviews.reject);
  const remove = useMutation(api.reviews.remove);
  const [deleteReviewId, setDeleteReviewId] = useState<Id<"reviews"> | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleApprove(id: Id<"reviews">) {
    try {
      await approve({ reviewId: id });
      toast({ title: "Avis publié", description: "L'avis est maintenant visible sur la landing page." });
    } catch (e: unknown) {
      toast({ title: "Erreur", description: e instanceof Error ? e.message : "Erreur", variant: "destructive" });
    }
  }

  async function handleReject(id: Id<"reviews">) {
    try {
      await reject({ reviewId: id });
      toast({ title: "Avis masqué", description: "L'avis ne sera plus affiché publiquement." });
    } catch (e: unknown) {
      toast({ title: "Erreur", description: e instanceof Error ? e.message : "Erreur", variant: "destructive" });
    }
  }

  async function handleDelete(id: Id<"reviews">) {
    setDeleteReviewId(id);
  }

  async function confirmDelete() {
    if (!deleteReviewId) return;
    
    setIsDeleting(true);
    try {
      await remove({ reviewId: deleteReviewId });
      toast({ title: "Avis supprimé" });
      setDeleteReviewId(null);
    } catch (e: unknown) {
      toast({ title: "Erreur", description: e instanceof Error ? e.message : "Erreur", variant: "destructive" });
    } finally {
      setIsDeleting(false);
    }
  }

  const approvedCount = reviews?.filter((r) => r.isApproved).length ?? 0;
  const pendingCount = reviews?.filter((r) => !r.isApproved).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center gap-3">
            <MessageSquareHeart className="w-6 h-6 text-secondary" />
            Avis Clients
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Modérez les avis avant publication sur la landing page
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-center bg-green-50 border border-green-200 rounded-xl px-4 py-2">
            <p className="text-xl font-bold text-green-700">{approvedCount}</p>
            <p className="text-xs text-green-600">Publiés</p>
          </div>
          <div className="text-center bg-amber-50 border border-amber-200 rounded-xl px-4 py-2">
            <p className="text-xl font-bold text-amber-700">{pendingCount}</p>
            <p className="text-xs text-amber-600">En attente</p>
          </div>
        </div>
      </div>

      {reviews === undefined && (
        <div className="text-center py-12 text-muted-foreground">Chargement…</div>
      )}

      {reviews?.length === 0 && (
        <div className="text-center py-16 text-muted-foreground bg-muted rounded-2xl border border-border">
          <MessageSquareHeart className="w-10 h-10 mx-auto mb-3 text-border" />
          <p className="font-medium">Aucun avis pour l'instant</p>
          <p className="text-sm mt-1">Les avis soumis par les clients complétés apparaîtront ici</p>
        </div>
      )}

      <div className="space-y-4">
        {reviews?.map((review) => (
          <div
            key={review._id}
            className={`bg-white rounded-2xl border shadow-sm p-6 flex flex-col gap-4 ${
              review.isApproved ? "border-green-200" : "border-border"
            }`}
          >
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary text-sm flex-shrink-0">
                  {review.displayName[0]}
                </div>
                <div>
                  <p className="font-bold text-primary">{review.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    {review.city} · {review.destination}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatDate(review.createdAt)}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ${
                  review.isApproved
                    ? "bg-green-100 text-green-700"
                    : "bg-amber-100 text-amber-700"
                }`}>
                  {review.isApproved ? (
                    <><Eye className="w-3 h-3" /> Publié</>
                  ) : (
                    <><EyeOff className="w-3 h-3" /> En attente</>
                  )}
                </span>

                {!review.isApproved ? (
                  <Button
                    size="sm"
                    onClick={() => handleApprove(review._id)}
                    className="bg-green-600 hover:bg-green-700 text-white h-8 gap-1.5 text-xs"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> Publier
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleReject(review._id)}
                    className="h-8 gap-1.5 text-xs border-amber-200 text-amber-700 hover:bg-amber-50"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Masquer
                  </Button>
                )}

                <AlertDialog open={deleteReviewId === review._id} onOpenChange={(open) => !open && setDeleteReviewId(null)}>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDelete(review._id)}
                      className="h-8 gap-1.5 text-xs border-red-200 text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Supprimer définitivement cet avis</AlertDialogTitle>
                      <AlertDialogDescription>
                        Êtes-vous sûr de vouloir supprimer cet avis ? Cette action est irréversible.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Annuler</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={confirmDelete}
                        disabled={isDeleting}
                        className="bg-red-600 hover:bg-red-700"
                      >
                        {isDeleting ? "Suppression..." : "Supprimer"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  className={`w-4 h-4 ${i < review.rating ? "text-secondary fill-secondary" : "text-border"}`}
                />
              ))}
              <span className="text-sm font-semibold text-primary ml-1">{review.rating}/5</span>
            </div>

            <blockquote className="text-sm text-foreground bg-muted rounded-xl p-4 italic leading-relaxed border border-border">
              "{review.comment}"
            </blockquote>

            <p className="text-xs text-muted-foreground">
              Dossier : <span className="font-mono font-semibold">{review.applicantName}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
