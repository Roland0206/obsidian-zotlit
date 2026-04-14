declare module "flexsearch" {
  export type DocumentSearchOptions<T = false> = Record<string, unknown>;

  export interface SimpleDocumentSearchResultSetUnit {
    id: string | number;
    doc?: unknown;
    field?: string;
    result?: unknown;
  }
}

declare module "flexsearch/src/document" {
  export default class Document<T = unknown, Async extends boolean = boolean> {
    constructor(options?: Record<string, unknown>);
    addAsync(id: string | number, doc: T): Promise<void>;
    removeAsync(id: string | number): Promise<void>;
    updateAsync(id: string | number, doc: T): Promise<void>;
    searchAsync(options: Record<string, unknown>): Promise<import("flexsearch").SimpleDocumentSearchResultSetUnit[]>;
  }
}

declare module "flexsearch/src/lang/en.js" {
  const language: unknown;
  export default language;
}

declare module "flexsearch/src/lang/latin/default.js" {
  const charset: unknown;
  export default charset;
}
