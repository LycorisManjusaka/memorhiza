// Next.js calls register() once when the server process starts.
// Used for exactly one thing: the wake clock (lib/wakeClock.ts), the only part
// of NEXUS that starts a turn with nobody's screen behind it. Whether it does
// anything is decided by wake/clock.json — this only starts the timer.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { ensureWakeClock } = await import('@/lib/wakeClock');
  ensureWakeClock();
}
