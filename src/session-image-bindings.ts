import { submitFormOnControlEnter } from "./client-actions.ts";
import { readPastedAgentImageFiles } from "./session-image-input.ts";

export function bindSessionImageInputs(
  panel: Element,
  addImages: (files: readonly File[], follow: boolean) => Promise<void>,
): void {
  for (const input of panel.querySelectorAll<HTMLInputElement>(
    'input[type="file"][data-action]',
  )) {
    input.addEventListener("change", () => {
      const files = input.files === null ? [] : [...input.files];
      input.value = "";
      if (files.length > 0) {
        void addImages(
          files,
          input.dataset["action"] === "add-follow-up-images",
        );
      }
    });
  }
  for (const textarea of panel.querySelectorAll<HTMLTextAreaElement>(
    'textarea[name="prompt"]',
  )) {
    textarea.addEventListener("paste", (event) => {
      const files = readPastedAgentImageFiles(event);
      if (files.length > 0) {
        void addImages(
          files,
          textarea.form?.dataset["action"] === "send-session-message",
        );
      }
    });
    textarea.addEventListener("keydown", (event) => {
      if (textarea.form !== null) {
        submitFormOnControlEnter(event, textarea.form);
      }
    });
  }
}
