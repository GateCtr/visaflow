export declare function stripAccents(value: string): string;
export declare function inferQuestionFocus(
  message: string
):
  | "appointment_payment_terms"
  | "appointment_price"
  | "document_price"
  | "appointment_timeline"
  | "document_timeline"
  | "price_timeline"
  | "payment_terms"
  | "payment_structure"
  | "appointment_only"
  | "price_only"
  | "document"
  | "timeline"
  | "eligibility"
  | "full_service"
  | "mixed_multi"
  | "general";
export declare function buildQuestionFocusBlock(message: string): string;
