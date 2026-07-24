import { SessionFollowUp } from "../session-client-forms.tsx";

export function SessionShortcutTestView() {
  return (
    <SessionFollowUp
      availabilityDescriptionId="session-composer-state"
      availabilityLabel="Ready for another instruction."
      continueVisible
      disabled={false}
      images={[]}
      onAddImages={() => undefined}
      onContinue={() => undefined}
      onInput={() => undefined}
      onRemoveImage={() => undefined}
      onSubmit={() => undefined}
      prompt="Follow up"
      sending={false}
    />
  );
}
