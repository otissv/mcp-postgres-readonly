# MCP Postgres Read-only Server

Local-only MCP server for read-only PostgreSQL queries (list schemas, list tables, describe table, run SELECT).

## Security and defense in depth

The server is designed for local development only and enforces multiple layers:

1. **Startup guards** — Refuses to run when `APP_ENV === "production"` and requires `ENABLE_LOCAL_MCP=true`. Never enable in production.
2. **PostgreSQL session** — `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` so the session cannot write even if the app layer were bypassed.
3. **Application SQL gate** — Only queries starting with `SELECT` or `WITH ... SELECT` are allowed; write/admin keywords are blocked as whole tokens (word boundaries).
4. **Timeouts** — `statement_timeout` and `idle_in_transaction_session_timeout` (5s) limit runaway or stuck queries.
5. **Parameterized queries** — Schema/table and query parameters are bound; no string concatenation for user input.
6. **Output cap** — Query results are limited to 500 rows.
7. **Schema path** — If `MCP_QUERY_SCHEMA_PATH` is set, the resolved path must stay under the current working directory (no path traversal).

**Recommendation:** Create a dedicated read-only database user (e.g. `mcp_readonly`) and grant only `USAGE` on schemas and `SELECT` on tables. That way even a bug or bypass in the app or session settings cannot write data. See “Table listing and fallback connection” below for GRANT examples.

## Query parameters

The `query` tool accepts optional **query params** so you can run parameterized SQL (recommended for safety and correctness):

- **`sql`** — Your SELECT (or WITH ... SELECT) with placeholders `$1`, `$2`, ...
- **`params`** — Array of values in order, e.g. `[42, "foo"]` for `$1`, `$2`.

Example:

```json
{ "sql": "SELECT * FROM users WHERE id = $1 AND status = $2", "params": [42, "active"] }
```

The server passes `params` to `pg`'s `Client#query(sql, params)`; types can be string, number, boolean, or null.

## Table listing and fallback connection

If `list_tables` returns an empty list even though the database has tables, the MCP user (`mcp_readonly`) likely has no privileges on those tables. The server can use a **fallback connection** with the app user so table listing works:

1. **Restart the MCP server** (e.g. restart Cursor or reload MCP).
2. In `.cursor/mcp.json`, add `POSTGRES_USER` and `POSTGRES_PASSWORD` to the server `env` so the fallback connection can see tables in `public` (same host/port/database as `MCP_DATABASE_URL`):

```json
"env": {
  "ENABLE_LOCAL_MCP": "true",
  "APP_ENV": "development",
  "NODE_ENV": "development",
  "MCP_DATABASE_URL": "postgres://mcp_readonly:mcp_password@127.0.0.1:5432/365cms",
  "POSTGRES_USER": "your_app_db_user",
  "POSTGRES_PASSWORD": "your_app_db_password"
}
```

Alternatively, grant the MCP user access so a fallback is not needed:

```sql
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
```
