export interface AccountExportRecord {
  readonly entity: string;
  readonly id: string;
  readonly payload: string;
  readonly tombstone: boolean;
}
export interface AccountExportBlob {
  readonly data: string;
  readonly digest: string;
  readonly size: number;
}
export interface AccountExport {
  readonly blobs: readonly AccountExportBlob[];
  readonly frontier: string;
  readonly manifest: readonly {
    readonly digest: string;
    readonly size: number;
  }[];
  readonly records: readonly AccountExportRecord[];
}
