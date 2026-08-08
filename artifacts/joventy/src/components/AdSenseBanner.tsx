import { useEffect, useRef } from "react";

declare global {
  interface Window {
    adsbygoogle: any[];
  }
}

interface AdSenseBannerProps {
  slot: string;
  className?: string;
}

export function AdSenseBanner({ slot, className = "" }: AdSenseBannerProps) {
  const adRef = useRef<HTMLModElement>(null);

  useEffect(() => {
    // Only load ads in production or if explicitly enabled
    if (import.meta.env.PROD || import.meta.env.VITE_ENABLE_ADS === "true") {
      try {
        if (window.adsbygoogle && adRef.current) {
          window.adsbygoogle.push({});
        }
      } catch (err) {
        console.warn("AdSense push failed:", err);
      }
    }
  }, []);

  return (
    <div className={`w-full ${className}`}>
      <ins
        ref={adRef}
        className="adsbygoogle block"
        style={{ display: "block" }}
        data-ad-format="autorelaxed"
        data-ad-client="ca-pub-4738268041520472"
        data-ad-slot={slot}
      />
    </div>
  );
}
