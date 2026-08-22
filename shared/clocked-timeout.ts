type ClearTimeoutFunction<Timer> = (id: Timer) => void;

type SetTimeoutFunction<Timer> = (
  callback: () => void,
  delay: number,
  ...rest: never[]
) => Timer;

export interface ClockedTimeoutOptions<
  Timer,
  SetTimeout extends SetTimeoutFunction<Timer> = SetTimeoutFunction<Timer>,
> {
  readonly clearTimeout: ClearTimeoutFunction<Timer>;
  readonly now: () => number;
  readonly setTimeout: SetTimeout;
}
