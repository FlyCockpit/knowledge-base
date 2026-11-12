declare module "pg" {
  export interface QueryResult<R = Record<string, unknown>> {
    rows: R[];
    rowCount: number | null;
  }

  export class Client {
    constructor(config?: {
      connectionString?: string;
      connectionTimeoutMillis?: number;
      application_name?: string;
      statement_timeout?: number;
      pipeline?: boolean;
    });
    on(event: "error" | "end", listener: (error?: Error) => void): this;
    connect(): Promise<void>;
    query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    query<R = Record<string, unknown>>(config: {
      text: string;
      values?: unknown[];
      queryMode: "extended";
    }): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }

  const pg: { Client: typeof Client };
  export default pg;
}
