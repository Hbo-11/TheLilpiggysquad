// Shared wiring for the Edge Functions. Runs only on the server: the database
// connection string and secrets come from the function environment and are never
// shipped to the mobile app.
import postgres from 'postgres'
import type { HandlerDeps } from '@apex/notifications-server'

let sql: ReturnType<typeof postgres> | null = null

export function deps(): HandlerDeps {
  const url = Deno.env.get('SUPABASE_DB_URL')
  if (!url) throw new Error('SUPABASE_DB_URL is not available to this function')
  // prepare:false keeps the client compatible with Supabase's transaction pooler.
  sql ??= postgres(url, { prepare: false, max: 3, idle_timeout: 20 })
  return { db: sql, env: (name) => Deno.env.get(name), fetch }
}

export async function serve(handler: (req: Request, deps: HandlerDeps) => Promise<Response>, req: Request): Promise<Response> {
  try {
    return await handler(req, deps())
  } catch (err) {
    // Log server-side; never echo internals to the caller.
    console.error(err)
    return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
}
