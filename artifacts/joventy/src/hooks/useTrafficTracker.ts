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

export function useTrafficTracker() {
  const [location] = useLocation();
  const recordPageView = useMutation(api.traffic.recordPageView);
  const updatePresence = useMutation(api.traffic.updatePresence);
  const sessionId = useRef(getSessionId());
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (lastPath.current === location) return;
    lastPath.current = location;
    recordPageView({ sessionId: sessionId.current, path: location }).catch(() => {});
    updatePresence({ sessionId: sessionId.current, path: location }).catch(() => {});
  }, [location, recordPageView, updatePresence]);

  useEffect(() => {
    const sid = sessionId.current;
    const tick = () => {
      updatePresence({ sessionId: sid, path: lastPath.current ?? "/" }).catch(() => {});
    };
    const interval = setInterval(tick, 30_000);
    return () => clearInterval(interval);
  }, [updatePresence]);
}
