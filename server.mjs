#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { Client } from "pg"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

/** Load optional query tool schema from .cursor/query.json when MCP_QUERY_SCHEMA_PATH is set (via mcp.json env). */
function loadQuerySchemaFromFile() {
  const path = process.env.MCP_QUERY_SCHEMA_PATH
  if (!path || typeof path !== "string") return null
  try {
    const cwd = process.cwd()
    const absolutePath = resolve(cwd, path)
    // Defense in depth: do not read outside project (avoid path traversal via env)
    const cwdPrefix = cwd.endsWith(sep) ? cwd : cwd + sep
    if (absolutePath !== cwd && !absolutePath.startsWith(cwdPrefix)) {
      return null
    }
    const raw = readFileSync(absolutePath, "utf8")
    const data = JSON.parse(raw)
    if (
      data &&
      typeof data.name === "string" &&
      typeof data.description === "string"
    ) {
      return { name: data.name, description: data.description }
    }
  } catch (_) {
    // ignore missing or invalid file
  }
  return null
}

const querySchemaFromFile = loadQuerySchemaFromFile()

/**
 * HARD FAIL SAFE:
 * - Never allow production
 * - Require an explicit local enable flag
 */
const APP_ENV = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development"
if (APP_ENV === "production") {
  console.error("[mcp-postgres-readonly] Refusing to start in production.")
  process.exit(1)
}
if (process.env.ENABLE_LOCAL_MCP !== "true") {
  console.error(
    "[mcp-postgres-readonly] Set ENABLE_LOCAL_MCP=true to run this server."
  )
  process.exit(1)
}

const connectionString =
  process.env.MCP_DATABASE_URL ??
  "postgres://mcp_readonly:mcp_password@127.0.0.1:5432/365cms"

const client = new Client({
  connectionString,
  // Extra belt & suspenders:
  // - statement_timeout prevents runaway queries
  // - application_name helps you identify the connection
  options:
    "-c statement_timeout=5000 -c idle_in_transaction_session_timeout=5000",
})

await client.connect()

// Force read-only at the session level too:
await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")

const server = new McpServer({
  name: "postgres-readonly-local",
  version: "0.1.0",
})

/**
 * Build a CallToolResult in the format expected by MCP clients (e.g. Cursor).
 * Content must be an array of blocks; text blocks must have type "text" and a string "text" property.
 */
function toolResultText(text) {
  const value =
    typeof text === "string" ? text : JSON.stringify(text ?? null, null, 2)
  return {
    content: [
      {
        type: "text",
        text: value,
      },
    ],
  }
}

/**
 * SQL keyword check: match only as whole tokens (word boundaries) to avoid
 * bypasses (e.g. "do;" when only "do " was banned) and reduce false positives
 * (e.g. column name "refresh" in SELECT refresh FROM t).
 */
const BANNED_SQL_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|vacuum|analyze|refresh|call|do|copy|execute|set|begin|commit|rollback)\b/i

function assertSelectOnly(sql) {
  if (typeof sql !== "string") {
    throw new Error("sql is required and must be a string")
  }
  const s = sql.trim()

  // Allow only SELECT / WITH ... SELECT (case-insensitive)
  const lower = s.toLowerCase()
  const ok =
    lower.startsWith("select") ||
    (lower.startsWith("with") && lower.includes("select"))

  if (!ok) throw new Error("Only SELECT queries are allowed.")

  // Block write/admin keywords as whole tokens only (defense in depth, fewer bypasses)
  if (BANNED_SQL_KEYWORDS.test(s)) {
    throw new Error("Query contains a disallowed keyword.")
  }
}

server.tool(
  "list_schemas",
  "List available schemas (public + tenant schemas t_*)",
  z.object({}),
  async () => {
    const { rows } = await client.query(`
      SELECT nspname AS schema
      FROM pg_namespace
      WHERE nspname = 'public' OR nspname LIKE 't\\_%' ESCAPE '\\'
      ORDER BY nspname;
    `)

    return toolResultText(rows)
  }
)

server.tool(
  querySchemaFromFile?.name ?? "query",
  querySchemaFromFile?.description ??
    'Run a read-only SQL query (SELECT only). Use $1, $2, ... in sql and pass params as an array, e.g. { "sql": "SELECT * FROM t WHERE id = $1", "params": [42] }. Add LIMITs.',
  z
    .object({
      sql: z.string().min(1).optional(),
      params: z.array(z.any()).optional().default([]),
    })
    .passthrough(),
  async (argsOrExtra, extraOrArgs) => {
    // SDK may pass (args, extra) or (extra, args); normalize to (args, extra)
    const firstHasSql =
      argsOrExtra && typeof argsOrExtra === "object" && "sql" in argsOrExtra
    const secondHasSql =
      extraOrArgs && typeof extraOrArgs === "object" && "sql" in extraOrArgs
    const firstLooksLikeExtra =
      argsOrExtra &&
      typeof argsOrExtra === "object" &&
      "requestId" in argsOrExtra
    const args = firstHasSql
      ? argsOrExtra
      : secondHasSql
        ? extraOrArgs
        : firstLooksLikeExtra
          ? extraOrArgs
          : argsOrExtra
    const extra = firstHasSql
      ? extraOrArgs
      : secondHasSql
        ? argsOrExtra
        : firstLooksLikeExtra
          ? argsOrExtra
          : extraOrArgs
    const fromArgs = args && typeof args === "object" ? args : {}
    // Raw arguments: from extra.request (set by our patch) or from args.params (if SDK passed raw request)
    const rawArguments =
      extra?.request?.params?.arguments ??
      (fromArgs?.params && typeof fromArgs.params === "object"
        ? fromArgs.params.arguments
        : undefined) ??
      fromArgs?.arguments
    let fromRequest =
      rawArguments != null ? rawArguments : (extra?.request?.params ?? {})
    if (typeof fromRequest === "string") {
      try {
        fromRequest = JSON.parse(fromRequest)
      } catch {
        fromRequest = {}
      }
    }
    if (typeof fromRequest !== "object" || fromRequest === null) {
      fromRequest = {}
    }
    const nested = fromArgs?.params?.arguments ?? fromArgs?.arguments ?? {}
    const rawArgs = {
      ...nested,
      ...fromRequest,
      ...fromArgs,
      ...(typeof extra?.request?.params === "object" &&
      extra.request.params !== null
        ? extra.request.params
        : {}),
    }
    // Accept sql from parsed args or raw request (MCP clients may send arguments in params.arguments)
    const sqlCandidate =
      fromArgs.sql ??
      rawArgs.sql ??
      rawArgs.SQL ??
      rawArgs.query ??
      rawArgs.arguments?.sql ??
      rawArgs.arguments?.SQL ??
      rawArgs.arguments?.query
    const querySql = typeof sqlCandidate === "string" ? sqlCandidate.trim() : ""
    if (!querySql) {
      throw new Error(
        'query tool requires argument: sql (string). Send arguments as { "sql": "SELECT ..." }. If you did, restart the MCP server (reload MCP / restart Cursor) and try again.'
      )
    }
    assertSelectOnly(querySql)

    const queryParams = Array.isArray(fromArgs.params)
      ? fromArgs.params
      : Array.isArray(rawArgs.params)
        ? rawArgs.params
        : []

    // Encourage limits, but don't force (Cursor prompts usually do).
    const { rows } = await client.query(querySql, queryParams)

    // Don’t return huge payloads
    const capped = rows.slice(0, 500)

    return toolResultText(capped)
  }
)

// Expose request on extra so tool handlers can read raw params.arguments (e.g. when client sends args the SDK doesn't pass through)
const underlying = server.server
const callToolMethod = "tools/call"
const originalCallTool = underlying._requestHandlers?.get(callToolMethod)
if (typeof originalCallTool === "function") {
  underlying._requestHandlers.set(callToolMethod, (request, extra) => {
    return originalCallTool(request, { ...extra, request })
  })
}

const transport = new StdioServerTransport()
await server.connect(transport)
