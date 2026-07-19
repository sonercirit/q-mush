import { HttpResponseError, request, requestJson } from "./browser-http.ts";
import {
  readOpenRouterCredentials,
  type OpenRouterViewState,
} from "./openrouter-client.tsx";
import { OPENROUTER_CREDENTIALS_PATH } from "./routes.ts";

const CONFIGURATION_ERROR =
  "OpenRouter storage is not configured. Set OPENROUTER_CREDENTIAL_KEY on the local server and restart it.";
const LOAD_ERROR =
  "We could not load your OpenRouter credentials. Please try again.";
const REMOVE_ERROR = "We could not remove that OpenRouter credential.";
const SAVE_ERROR =
  "We could not add that OpenRouter API key. Please try again.";

type ChangeListener = () => void;
type ErrorMessage = (status: number) => string;
type StatePatch = Partial<OpenRouterViewState>;

function loadError(status: number): string {
  return status === 503 ? CONFIGURATION_ERROR : LOAD_ERROR;
}

function saveError(status: number): string {
  if (status === 400) {
    return "OpenRouter rejected that API key. Check it and try again.";
  }

  if (status === 409) {
    return "That OpenRouter credential is already saved.";
  }

  return status === 503 ? CONFIGURATION_ERROR : SAVE_ERROR;
}

export class OpenRouterController {
  readonly #onChange: ChangeListener;
  #revision = 0;
  #state: OpenRouterViewState = {
    credentials: undefined,
    error: undefined,
    removingId: undefined,
    savePending: false,
  };

  constructor(onChange: ChangeListener) {
    this.#onChange = onChange;
  }

  get state(): OpenRouterViewState {
    return this.#state;
  }

  bind(container: Element): void {
    const form = container.querySelector<HTMLFormElement>(
      '[data-action="add-openrouter-key"]',
    );
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      const apiKey = new FormData(form).get("apiKey");

      if (typeof apiKey === "string") {
        void this.#add(apiKey);
      }
    });

    for (const button of container.querySelectorAll<HTMLButtonElement>(
      '[data-action="remove-openrouter-credential"]',
    )) {
      button.addEventListener("click", () => {
        const credentialId = button.dataset["credentialId"];

        if (credentialId !== undefined) {
          void this.#remove(credentialId);
        }
      });
    }

    container
      .querySelector('[data-action="retry-openrouter"]')
      ?.addEventListener("click", () => {
        void this.load();
      });
  }

  async load(): Promise<void> {
    const revision = ++this.#revision;
    this.#patch({ credentials: undefined, error: undefined });

    try {
      const credentials = readOpenRouterCredentials(
        await requestJson(OPENROUTER_CREDENTIALS_PATH),
      );

      if (revision === this.#revision) {
        this.#patch({ credentials, error: undefined });
      }
    } catch (error) {
      if (revision === this.#revision) {
        this.#patch({
          error:
            error instanceof HttpResponseError
              ? loadError(error.status)
              : LOAD_ERROR,
        });
      }
    }
  }

  reset(): void {
    this.#revision += 1;
    this.#replace({
      credentials: undefined,
      error: undefined,
      removingId: undefined,
      savePending: false,
    });
  }

  async #add(apiKey: string): Promise<void> {
    await this.#mutate(
      OPENROUTER_CREDENTIALS_PATH,
      {
        body: JSON.stringify({ apiKey }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      { savePending: true },
      { savePending: false },
      saveError,
    );
  }

  async #mutate(
    input: RequestInfo | URL,
    init: RequestInit,
    pending: StatePatch,
    settled: StatePatch,
    errorMessage: ErrorMessage,
  ): Promise<void> {
    const revision = this.#revision;
    this.#patch({ ...pending, error: undefined });

    try {
      await request(input, init);

      if (revision === this.#revision) {
        this.#patch(settled);
        await this.load();
      }
    } catch (error) {
      if (revision === this.#revision) {
        const status = error instanceof HttpResponseError ? error.status : 0;
        this.#patch({ ...settled, error: errorMessage(status) });
      }
    }
  }

  #patch(patch: StatePatch): void {
    this.#replace({ ...this.#state, ...patch });
  }

  #remove(credentialId: string): Promise<void> {
    return this.#mutate(
      `${OPENROUTER_CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}`,
      { method: "DELETE" },
      { removingId: credentialId },
      { removingId: undefined },
      () => REMOVE_ERROR,
    );
  }

  #replace(state: OpenRouterViewState): void {
    this.#state = state;
    this.#onChange();
  }
}
