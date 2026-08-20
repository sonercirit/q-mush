export class RunnerDisconnectedError extends Error {
  constructor(message = "The runner disconnected before the command returned") {
    super(message);
    this.name = "RunnerDisconnectedError";
  }
}
