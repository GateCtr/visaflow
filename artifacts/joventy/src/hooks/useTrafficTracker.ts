import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";

function getSessionId(): string {
  try {
    let id = sessionStorage.getItem("_jvt_sid");
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem("_jvt_sid", id);
    }
    return id;
  } catch {
    return "anon";
  }
}

function getInitialReferrer(): string {
  try {
    let ref = sessionStorage.getItem("_jvt_ref");
    if (ref === null) {
      ref = document.referrer || "";
      sessionStorage.setItem("_jvt_ref", ref);
    }
    return ref;
  } catch {
    return document.referrer || "";
  }
}

export function useTrafficTracker() {
  const [location] = useLocation();
  const recordPageView = useMutation(api.traffic.recordPageView);
  const updatePresence = useMutation(api.traffic.updatePresence);
  const sessionId = useRef(getSessionId());
  const referrer = useRef(getInitialReferrer());
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (lastPath.current === location) return;
    lastPath.current = location;
    if (location.startsWith("/admin")) return;
    recordPageView({
      sessionId: sessionId.current,
      path: location,
      referrer: referrer.current || undefined,
    }).catch(() => {});
    updatePresence({ sessionId: sessionId.current, path: location }).catch(() => {});
  }, [location, recordPageView, updatePresence]);

  useEffect(() => {
    const sid = sessionId.current;
    const tick = () => {
      const path = lastPath.current ?? "/";
      if (path.startsWith("/admin")) return;
      updatePresence({ sessionId: sid, path }).catch(() => {});
    };
    const interval = setInterval(tick, 30_000);
    return () => clearInterval(interval);
  }, [updatePresence]);
}
