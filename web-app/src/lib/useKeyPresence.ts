'use client';

// One shared answer to "which API keys does this install have?" for every
// picker on the page (2026-11-25). Booleans only: the key values are read from
// /api/keys, reduced by keyPresence(), and dropped.
//
// null until the first answer arrives, and null again never: a failed refresh
// keeps the last known answer. lib/providerAccess.ts treats null as "hide
// nothing".

import { useEffect, useState } from 'react';
import { keyPresence, type KeyPresence } from './providerAccess';

/** Fired by the settings window after it saves keys.json. */
export const KEYS_CHANGED_EVENT = 'nexus:keys-changed';

let cached: KeyPresence | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<(p: KeyPresence | null) => void>();

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetch('/api/keys')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((data) => {
      cached = keyPresence(data);
      listeners.forEach((fn) => fn(cached));
    })
    .catch(() => {})
    .finally(() => { inflight = null; });
  return inflight;
}

export function useKeyPresence(): KeyPresence | null {
  const [presence, setPresence] = useState<KeyPresence | null>(cached);
  useEffect(() => {
    listeners.add(setPresence);
    if (cached) setPresence(cached); else void refresh();
    const onChanged = () => { void refresh(); };
    window.addEventListener(KEYS_CHANGED_EVENT, onChanged);
    return () => {
      listeners.delete(setPresence);
      window.removeEventListener(KEYS_CHANGED_EVENT, onChanged);
    };
  }, []);
  return presence;
}
