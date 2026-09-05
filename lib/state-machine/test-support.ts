/**
 * In-memory fake of StatusDbClient, for the unit tests in this directory
 * only (never imported by application code). Not a stub that returns
 * canned responses: it actually stores rows in a Map and actually applies
 * compare-and-swap semantics on update (an update only matches a row whose
 * current value equals every `.eq()` filter given, exactly like the real
 * `UPDATE ... WHERE id = $1 AND status = $2`), so a test exercises the real
 * optimistic-concurrency behavior of applyStatusTransition() (db.ts)
 * instead of a hand-stubbed call.
 */

import type {
  PostgrestResult,
  StatusDbClient,
  StatusDbFilterBuilder,
  StatusDbTableClient,
} from "./db.ts";

export type FakeRow = Record<string, unknown>;

export interface FakeDbOptions {
  /**
   * If set, only these table names may be touched (select/update/insert) --
   * anything else throws synchronously (surfacing as a rejected promise at
   * the call site). Used to prove cross-entity independence, e.g. "a call
   * to transitionRfq() never touches orders or payments".
   */
  allowedTables?: readonly string[];
  /**
   * If set, any operation (select/update/insert) against this table
   * immediately resolves to { data: null, error: { message } } instead of
   * touching the in-memory rows -- simulates a database-level failure, to
   * exercise TransitionPersistenceError/AuditWriteError paths.
   */
  forcedErrors?: Readonly<Record<string, string>>;
}

export interface RecordedCall {
  table: string;
  op: "select" | "update" | "insert";
}

/** Not a real UUID -- this fake never reaches Postgres, so any unique string works. */
function randomId(): string {
  return `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class FakeStatusDb implements StatusDbClient {
  readonly tables = new Map<string, Map<string, FakeRow>>();
  readonly calls: RecordedCall[] = [];
  private readonly options: FakeDbOptions;

  constructor(options: FakeDbOptions = {}) {
    this.options = options;
  }

  /** Seeds one row (generating an id if the row has none) and returns it. */
  seed(table: string, row: FakeRow): FakeRow {
    const withId: FakeRow = row.id ? { ...row } : { ...row, id: randomId() };
    this.tableMap(table).set(withId.id as string, withId);
    return { ...withId };
  }

  /** Reads back the current stored state of one row, or undefined if absent. */
  getRow(table: string, id: string): FakeRow | undefined {
    const row = this.tableMap(table).get(id);
    return row ? { ...row } : undefined;
  }

  /** @internal exposed for FakeFilterBuilder, which lives in this same module. */
  tableMap(name: string): Map<string, FakeRow> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  /**
   * @internal exposed for FakeFilterBuilder. Records the call, enforces
   * allowedTables (throws -- this signals a test-authoring/production-code
   * bug, not a normal database error), and returns a forced error if
   * configured for this table.
   */
  beginOp(table: string, op: RecordedCall["op"]): { message: string } | null {
    this.calls.push({ table, op });
    if (this.options.allowedTables && !this.options.allowedTables.includes(table)) {
      throw new Error(
        `FakeStatusDb: table "${table}" was touched (${op}) but is not in ` +
          `allowedTables [${this.options.allowedTables.join(", ")}]. This ` +
          `usually means the code under test reached into a table it should ` +
          `not know about.`,
      );
    }
    const message = this.options.forcedErrors?.[table];
    return message ? { message } : null;
  }

  from(tableName: string): StatusDbTableClient {
    // Arrow-function properties (not method shorthand) so `this` inside each
    // one is lexically bound to this FakeStatusDb instance, with no `const
    // db = this` alias -- @typescript-eslint/no-this-alias forbids that.
    return {
      select: (): StatusDbFilterBuilder => {
        return new FakeFilterBuilder(this, tableName, "select", {});
      },
      update: (patch: Record<string, unknown>): StatusDbFilterBuilder => {
        return new FakeFilterBuilder(this, tableName, "update", patch);
      },
      insert: async (row: Record<string, unknown>): Promise<PostgrestResult<null>> => {
        const error = this.beginOp(tableName, "insert");
        if (error) return { data: null, error };
        const withId: FakeRow = row.id ? { ...row } : { ...row, id: randomId() };
        this.tableMap(tableName).set(withId.id as string, withId);
        return { data: null, error: null };
      },
    };
  }
}

class FakeFilterBuilder implements StatusDbFilterBuilder {
  private readonly filters: Array<[string, unknown]> = [];
  // Plain fields assigned in the constructor body, not TS parameter-property
  // shorthand (`constructor(private readonly x: T) {}`): Node's built-in
  // TypeScript stripping (node --test on a .ts file, strip-only mode) throws
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX on parameter properties, since erasing
  // them isn't a pure type-level strip -- it has to synthesize an
  // assignment. Confirmed empirically. errors.ts's classes already followed
  // this style; this is the only class in the directory that didn't.
  private readonly db: FakeStatusDb;
  private readonly tableName: string;
  private readonly op: "select" | "update";
  private readonly patch: Record<string, unknown>;

  constructor(
    db: FakeStatusDb,
    tableName: string,
    op: "select" | "update",
    patch: Record<string, unknown>,
  ) {
    this.db = db;
    this.tableName = tableName;
    this.op = op;
    this.patch = patch;
  }

  eq(column: string, value: unknown): StatusDbFilterBuilder {
    this.filters.push([column, value]);
    return this;
  }

  limit(): StatusDbFilterBuilder {
    // Every fake query already resolves at most one row via the loop in
    // maybeSingle(); a row cap has nothing further to restrict.
    return this;
  }

  select(): StatusDbFilterBuilder {
    return this;
  }

  async maybeSingle(): Promise<PostgrestResult<Record<string, unknown>>> {
    const error = this.db.beginOp(this.tableName, this.op);
    if (error) return { data: null, error };

    const table = this.db.tableMap(this.tableName);
    let matchId: string | null = null;
    for (const [id, row] of table) {
      if (this.filters.every(([column, value]) => row[column] === value)) {
        matchId = id;
        break;
      }
    }

    if (matchId === null) {
      return { data: null, error: null };
    }

    if (this.op === "update") {
      const existing = table.get(matchId);
      if (!existing) {
        return { data: null, error: null };
      }
      const updated = { ...existing, ...this.patch };
      table.set(matchId, updated);
      return { data: { id: matchId }, error: null };
    }

    const row = table.get(matchId);
    return { data: row ? { ...row } : null, error: null };
  }
}
