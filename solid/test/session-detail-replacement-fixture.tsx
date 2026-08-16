import { createSignal, untrack, type JSX } from "solid-js";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SessionDetailBody } from "../session-detail-body.tsx";
import type { LoadedSessionDetailViewProps } from "../session-detail-view-props.ts";
import { summaryFromDetail } from "../session-summary-codec.ts";

interface SessionDetailReplacement {
  readonly render: (
    props: Parameters<typeof SessionDetailBody>[0],
  ) => JSX.Element;
  readonly replace: (detail: AgentSessionDetail) => void;
}

export function createSessionDetailReplacement(): SessionDetailReplacement {
  let replace: ((detail: AgentSessionDetail) => void) | undefined;
  return {
    render: (props) => {
      const [view, setView] = createSignal<LoadedSessionDetailViewProps>(
        untrack(() => props.view),
      );
      replace = (detail) => {
        setView((current) => ({
          ...current,
          detail,
          state: {
            ...current.state,
            detail,
            selectedId: detail.id,
            sessions: [summaryFromDetail(detail)],
          },
        }));
      };
      return <SessionDetailBody {...props} view={view()} />;
    },
    replace: (detail) => {
      if (replace === undefined) {
        throw new TypeError("The session detail replacement is not mounted");
      }
      replace(detail);
    },
  };
}
