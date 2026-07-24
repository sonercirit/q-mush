import { For, Show, type JSX } from "solid-js";

interface StatusAction {
  readonly label: string;
  readonly primary?: boolean;
  readonly run: () => void;
}

interface StatusNotice {
  readonly action?: StatusAction;
  readonly body: string;
  readonly dismiss?: () => void;
  readonly heading?: string;
  readonly tone: "amber" | "cyan" | "emerald";
}

export interface PwaStatusProps {
  readonly installed: boolean;
  readonly installAvailable: boolean;
  readonly iosInstallAvailable: boolean;
  readonly loading: boolean;
  readonly offline: boolean;
  readonly onDismissInstall: () => void;
  readonly onDismissIosInstall: () => void;
  readonly onDismissUpdate: () => void;
  readonly onInstall: () => void;
  readonly onReload: () => void;
  readonly updateAvailable: boolean;
}

const TONE_CLASSES = {
  amber: "border-amber-300/30 bg-amber-300/10 text-amber-100",
  cyan: "border-cyan-300/30 bg-cyan-300/10 text-cyan-100",
  emerald: "border-emerald-300/20 bg-emerald-300/10 text-emerald-100",
} as const;

function actionClasses(action: StatusAction): string {
  return action.primary === true
    ? "self-start rounded-full bg-cyan-200 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-200"
    : "self-start rounded-full border border-current/30 px-4 py-2 text-sm font-semibold transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-current";
}

function StatusNoticeView(props: {
  readonly notice: StatusNotice;
}): JSX.Element {
  return (
    <section
      class={`flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between ${TONE_CLASSES[props.notice.tone]}`}
      role="status"
    >
      <p>
        <Show when={props.notice.heading}>
          {(heading) => <span class="font-semibold">{heading()} </span>}
        </Show>
        {props.notice.body}
      </p>
      <Show when={props.notice.action !== undefined || props.notice.dismiss}>
        <div class="flex shrink-0 flex-wrap items-center gap-3">
          <Show when={props.notice.action}>
            {(action) => (
              <button
                class={actionClasses(action())}
                onClick={action().run}
                type="button"
              >
                {action().label}
              </button>
            )}
          </Show>
          <Show when={props.notice.dismiss}>
            {(dismiss) => (
              <button
                class="self-start rounded-full px-3 py-2 text-sm font-semibold underline decoration-current/50 underline-offset-4 transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-current"
                onClick={dismiss()}
                type="button"
              >
                Dismiss
              </button>
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
}

function statusNotices(props: PwaStatusProps): readonly StatusNotice[] {
  const notices: StatusNotice[] = [];
  if (props.offline) {
    notices.push({
      action: { label: "Retry connection", run: props.onReload },
      body: "Reconnect to verify your session. Private workspace data is not available from the offline shell.",
      heading: "You’re offline",
      tone: "amber",
    });
  }
  if (props.updateAvailable) {
    notices.push({
      action: { label: "Reload", primary: true, run: props.onReload },
      body: "Reload when you’re ready to use the latest Q Mush shell.",
      dismiss: props.onDismissUpdate,
      heading: "Update available.",
      tone: "cyan",
    });
  }
  if (!props.loading && !props.installed && props.installAvailable) {
    notices.push({
      action: { label: "Install app", run: props.onInstall },
      body: "Install Q Mush for a standalone app and offline startup.",
      dismiss: props.onDismissInstall,
      tone: "emerald",
    });
  }
  if (!props.loading && !props.installed && props.iosInstallAvailable) {
    notices.push({
      body: "To install Q Mush, open the Share menu and choose Add to Home Screen.",
      dismiss: props.onDismissIosInstall,
      tone: "emerald",
    });
  }
  return notices;
}

export function PwaStatus(props: PwaStatusProps): JSX.Element {
  return (
    <div aria-atomic="true" aria-live="polite" class="mt-6 space-y-3">
      <For each={statusNotices(props)}>
        {(notice) => <StatusNoticeView notice={notice} />}
      </For>
    </div>
  );
}
