import type { JSX } from "solid-js";
import { RetryNotice } from "./collection.tsx";

export function ControllerRetryNotice(props: {
  readonly error: string | undefined;
  readonly load: () => Promise<void>;
}): JSX.Element {
  return (
    <RetryNotice
      error={props.error}
      onRetry={() => {
        void props.load();
      }}
    />
  );
}
