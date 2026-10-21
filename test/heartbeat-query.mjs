import { DatabaseSync } from 'node:sqlite';

// SDK db.query(sql, params) returns raw rows. Execute SELECTs against fixture
// rows so predicates, grouping and aliases affect the result, without a real
// database, runtime capability grant, or invented heartbeat-list API.
export function heartbeatQuery(runs = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    ATTACH DATABASE ':memory:' AS public;
    CREATE TABLE public.heartbeat_runs (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', invocation_source TEXT NOT NULL DEFAULT 'on_demand',
      trigger_detail TEXT, context_snapshot TEXT, started_at TEXT, finished_at TEXT,
      wakeup_request_id TEXT, created_at TEXT, updated_at TEXT
    );
  `);
  const columns = ['id', 'company_id', 'agent_id', 'status', 'invocation_source', 'trigger_detail',
    'context_snapshot', 'started_at', 'finished_at'];
  const insert = db.prepare(`INSERT INTO public.heartbeat_runs (${columns.join(', ')})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of runs) insert.run(...columns.map(k => row[k] ?? null));
  return {
    close: () => db.close(),
    query: async (sql, params = []) => {
      if (!/^SELECT\b/i.test(sql.trim())) throw new Error('fixture-query-must-be-read-only');
      // SQLite supports PostgreSQL $n bind names; strip scalar casts only.
      const portable = sql.replace(/::(?:uuid|text|int(?:eger)?|bigint)\b/gi, '');
      const statement = db.prepare(portable);
      const binds = Object.fromEntries(params.map((value, i) => [String(i + 1), value]));
      return statement.all(binds).map(row => ({ ...row }));
    },
  };
}
