type ClearTimeoutFunction<Timer> = (id: Timer) => void;

export interface ClockedTimeoutOptions<Timer> {
  readonly clearTimeout: ClearTimeoutFunction<Timer>;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => Timer;
}
