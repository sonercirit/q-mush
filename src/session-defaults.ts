import type { SessionDraft } from "./session-client.tsx";

function hiddenValue(panel: Element, name: string): string | undefined {
  return panel.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;
}

function sessionDraftWithDefaults(
  draft: SessionDraft,
  credential: string,
  runnerId: string,
  credentialSettled: boolean,
): SessionDraft {
  const defaultedCredential = credentialSettled ? credential : draft.credential;
  return {
    ...draft,
    credential: defaultedCredential,
    ...(defaultedCredential === draft.credential
      ? {}
      : { model: "", reasoningEffort: "" }),
    runnerId,
  };
}

export function defaultedSessionDraft(
  panel: Element,
  draft: SessionDraft,
): SessionDraft | undefined {
  const credential = hiddenValue(panel, "credential");
  const runnerId = hiddenValue(panel, "runnerId");

  const credentialSettled =
    panel.getAttribute("data-credentials-settled") === "true";
  const next = sessionDraftWithDefaults(
    draft,
    credential ?? "",
    runnerId ?? "",
    credentialSettled,
  );

  return next.credential === draft.credential &&
    next.runnerId === draft.runnerId
    ? draft
    : next;
}
