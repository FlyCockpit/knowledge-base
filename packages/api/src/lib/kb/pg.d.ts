declare module "pg" {
  export interface QueryResult<R = Record<string, unknown>> {
    rows: R[];
    rowCount: number | null;
  }

  /** A LISTEN notification (R3-W4 dispatcher wake). */
  export interface Notification {
    processId: number;
    channel: string;
    payload?: string;
  }

  export interface DatabaseError extends Error {
    code?: string;
  }

  export class Client {
    constructor(config?: {
      connectionString?: string;
      stream?: () => import("node:stream").Duplex;
      connectionTimeoutMillis?: number;
      application_name?: string;
      statement_timeout?: number;
      options?: string;
      query_timeout?: number;
    });
    on(event: "error" | "end", listener: (error?: Error) => void): this;
    on(event: "notification", listener: (message: Notification) => void): this;
    removeListener(event: "error" | "end", listener: (error?: Error) => void): this;
    connect(): Promise<void>;
    query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    query<R = Record<string, unknown>>(config: {
      text: string;
      values?: unknown[];
      queryMode: "extended";
    }): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
}
