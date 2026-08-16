import type { AgentSessionDetail } from "../../shared/session-model.ts";

export interface SessionScrollTestView {
  readonly expectFrames: (count: number) => void;
  readonly expectLocked: (enabled: boolean) => void;
  readonly expectTop: (position: number) => void;
  readonly growBeforePaint: (height: number) => void;
  readonly notifyScroll: () => void;
  readonly paintAfterLayout: (height: number) => void;
  readonly scrollTo: (position: number) => void;
  readonly stream: (content: string, appendMessage?: boolean) => void;
  readonly transitionTo: (detail: AgentSessionDetail) => void;
}

export function unlockScrollTestView(view: SessionScrollTestView): void {
  view.scrollTo(200);
  view.expectLocked(false);
}

export function expectScrollTestPaint(
  view: SessionScrollTestView,
  height: number,
): void {
  view.expectFrames(1);
  view.paintAfterLayout(height);
  view.expectTop(height);
}
