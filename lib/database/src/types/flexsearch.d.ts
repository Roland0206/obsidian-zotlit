declare module "flexsearch" {
  export type DocumentSearchOptions<T = false> = Record<string, unknown>;

  export interface SimpleDocumentSearchResultSetUnit {
    id: string | number;
    doc?: unknown;
    field?: string;
    result?: unknown;
  }
}
