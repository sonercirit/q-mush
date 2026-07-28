import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

const [liveNow, setLiveNow] = createSignal(Date.now());
let activeClockCount = 0;
let liveTimer: number | undefined;

function subscribeToLiveNow(): () => void {
  activeClockCount += 1;
  setLiveNow(Date.now());
  liveTimer ??= window.setInterval(() => {
    setLiveNow(Date.now());
  }, 1_000);
  return () => {
    activeClockCount -= 1;
    if (activeClockCount === 0 && liveTimer !== undefined) {
      window.clearInterval(liveTimer);
      liveTimer = undefined;
    }
  };
}

export function createLiveNow(active: Accessor<boolean>): Accessor<number> {
  createEffect(() => {
    if (!active()) return;
    const unsubscribe = subscribeToLiveNow();
    onCleanup(unsubscribe);
  });
  return liveNow;
}
