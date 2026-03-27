import "@supabase/functions-js/edge-runtime.d.ts"
import postgres from "npm:postgres"

const sql = postgres(Deno.env.get("POSTGRES_URL")!, { ssl: "require" })

Deno.serve(async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  const url = new URL(req.url)
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 10000)
  const replayFile = url.searchParams.get("replay_file")

  try {
    const rows = replayFile
      ? await sql`
          SELECT * FROM games
          WHERE replay_file = ${replayFile}
          LIMIT 1
        `
      : await sql`
          SELECT * FROM games
          ORDER BY played_at DESC
          LIMIT ${limit}
        `

    const data = rows.map(r => ({ ...r, id: Number(r.id) }))
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (e) {
    console.error("DB query error:", e)
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})
