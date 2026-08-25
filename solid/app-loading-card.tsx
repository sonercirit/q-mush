import type { JSX } from "solid-js";

export function AppLoadingCard(): JSX.Element {
  return (
    <div
      class="mt-8 rounded-3xl border border-white/10 bg-white/[0.06] p-5 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:mt-12 sm:p-8"
      role="status"
    >
      <div class="flex items-center gap-4">
        <span
          aria-hidden="true"
          class="size-3 animate-pulse rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,0.8)]"
        />
        <p class="font-medium text-slate-200">Checking your session…</p>
      </div>
    </div>
  );
}
