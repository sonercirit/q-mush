interface NoticeConfiguration {
  readonly fallback: string;
  readonly outcomes: Readonly<Record<string, string>>;
}

const NOTICES: Readonly<Record<"google" | "openrouter", NoticeConfiguration>> =
  {
    google: {
      fallback: "Google sign-in did not finish. Please try again.",
      outcomes: {
        denied:
          "Google sign-in was canceled. You can try again when you are ready.",
        invalid_state:
          "That sign-in attempt could not be verified. Please start a new one.",
      },
    },
    openrouter: {
      fallback: "The OpenRouter connection did not finish. Please try again.",
      outcomes: {
        connected:
          "OpenRouter account connected. Its API key is ready on this machine.",
        denied: "OpenRouter access was canceled. Nothing was added.",
        invalid_state:
          "That OpenRouter connection could not be verified. Please start a new one.",
      },
    },
  };

export function providerNotice(
  provider: "google" | "openrouter",
  result: string | null,
): string | undefined {
  if (result === null) {
    return undefined;
  }

  const configuration = NOTICES[provider];
  return configuration.outcomes[result] ?? configuration.fallback;
}
