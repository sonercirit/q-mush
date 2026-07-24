export interface RunnerDirectoryRequest {
  readonly authorize?: () => boolean;
  readonly path: string;
  readonly runnerId: string;
  readonly userId: string;
}
