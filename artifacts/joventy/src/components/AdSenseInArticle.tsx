import { useEffect, useRef } from "react";

declare global {
  interface Window {
    adsbygoogle: any[];
  }
}

interface AdSenseInArticleProps {
  slot: string;
  className?: string;
}

export function AdSenseInArticle({ slot, className = "" }: AdSenseInArticleProps) {
  const adRef = useRef<HTMLModElement>(null);

  useEffect(() => {
    // Only load ads in production or if explicitly enabled
    if (import.meta.env.PROD || import.meta.env.VITE_ENABLE_ADS === "true") {
      try {
        if (window.adsbygoogle && adRef.current) {
          window.adsbygoogle.push({});
        }
      } catch (err) {
        console.warn("AdSense in-article push failed:", err);
      }
    }
  }, []);

  return (
    <div className={`w-full my-4 ${className}`}>
      <ins
        ref={adRef}
        className="adsbygoogle block"
        style={{ display: "block", textAlign: "center" }}
        data-ad-layout="in-article"
        data-ad-format="fluid"
        data-ad-client="ca-pub-4738268041520472"
        data-ad-slot={slot}
      />
    </div>
  );
}
