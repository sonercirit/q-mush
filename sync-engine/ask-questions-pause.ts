export class AskQuestionsPause extends Error {
  constructor() {
    super("The agent session is waiting for question answers");
    this.name = "AskQuestionsPause";
  }
}
