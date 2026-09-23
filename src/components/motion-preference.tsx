"use client";

import * as React from "react";
import {
  applyMotion,
  currentMotion,
  DEFAULT_MOTION,
  type Motion,
  MOTION_EVENT,
  REDUCED_MOTION_QUERY,
  savedMotion,
  setMotion as storeMotion,
} from "@/lib/motion";

/**
 * The stored motion preference as React state, the counterpart of
 * `useThemePreference`. It starts at the default so the first client render
 * matches the server's, then adopts the stored value after hydration.
 */
export function useMotionPreference(): [Motion, (value: Motion) => void] {
  const [motion, setMotion] = React.useState<Motion>(DEFAULT_MOTION);

  React.useEffect(() => {
    setMotion(savedMotion());
  }, []);

  // Under "Follow system", an OS change re-resolves the attribute live.
  React.useEffect(() => {
    if (motion !== "system") return;
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => applyMotion("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [motion]);

  React.useEffect(() => {
    const onChange = (e: Event) => setMotion((e as CustomEvent<Motion>).detail);
    window.addEventListener(MOTION_EVENT, onChange);
    return () => window.removeEventListener(MOTION_EVENT, onChange);
  }, []);

  const update = React.useCallback((value: Motion) => {
    setMotion(value);
    storeMotion(value);
  }, []);

  return [motion, update];
}

/**
 * Whether motion should be reduced right now, read from `<html data-motion>`
 * (so it honours both the setting and, under "Follow system", the OS). For
 * code that animates outside CSS, like the ECharts wrapper.
 */
export function useReducedMotion(): boolean {
  // Read the attribute on the first client render: the bootstrap script has
  // already set it, and nothing this feeds changes markup, so there is no
  // hydration to disagree with. The server has no document and says false.
  const [reduced, setReduced] = React.useState(
    () => typeof document !== "undefined" && currentMotion() === "reduce",
  );

  React.useEffect(() => {
    const read = () => setReduced(currentMotion() === "reduce");
    read();
    // The event fires after the attribute is updated; the media query covers
    // an OS change while "Follow system" is selected.
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const onMedia = () => setTimeout(read, 0);
    window.addEventListener(MOTION_EVENT, read);
    media.addEventListener("change", onMedia);
    return () => {
      window.removeEventListener(MOTION_EVENT, read);
      media.removeEventListener("change", onMedia);
    };
  }, []);

  return reduced;
}
