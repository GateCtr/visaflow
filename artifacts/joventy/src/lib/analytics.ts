type AnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void;
    };
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;

  try {
    window.umami?.track(name, data);
  } catch {
    // Analytics must never interrupt the visitor journey.
  }
}

export function classifyAiReferrer(referrer: string): string | null {
  if (!referrer) return null;

  let host: string;
  try {
    host = new URL(referrer).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }

  if (host === "chatgpt.com" || host === "chat.openai.com") return "chatgpt";
  if (host === "perplexity.ai") return "perplexity";
  if (host === "gemini.google.com" || host === "bard.google.com") return "gemini";
  if (host === "copilot.microsoft.com") return "microsoft_copilot";
  if (host === "claude.ai") return "claude";
  if (host === "you.com") return "you_com";
  if (host === "poe.com") return "poe";
  if (host === "mistral.ai" || host === "chat.mistral.ai") return "mistral";

  return null;
}