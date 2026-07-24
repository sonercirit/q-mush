import { SessionFollowUp } from "../session-client-forms.tsx";

export function SessionShortcutTestView() {
  return (
    <SessionFollowUp
      available={true}
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
