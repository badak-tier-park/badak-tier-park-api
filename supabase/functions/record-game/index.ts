import "@supabase/functions-js/edge-runtime.d.ts"
import postgres from "npm:postgres"

const sql = postgres(Deno.env.get("POSTGRES_URL")!, { ssl: "require" })
const APP_SECRET = Deno.env.get("APP_SECRET")!

interface GamePayload {
  discord_id: number
  played_at: string
  map_name: string
  game_duration_seconds: number
  winner_name: string
  winner_race: string
  loser_name: string
  loser_race: string
  winner_apm: number
  loser_apm: number
  replay_file: string
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  if (req.headers.get("X-App-Secret") !== APP_SECRET) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
  }

  let payload: GamePayload
  try {
    payload = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const required = [
    "discord_id", "played_at", "map_name", "game_duration_seconds",
    "winner_name", "winner_race", "loser_name", "loser_race",
    "winner_apm", "loser_apm", "replay_file",
  ]
  for (const field of required) {
    if (payload[field as keyof GamePayload] === undefined) {
      return new Response(JSON.stringify({ error: `Missing field: ${field}` }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
  }

  const seasons = await sql`SELECT id FROM seasons ORDER BY id DESC LIMIT 1`
  const seasonId: number | null = seasons.length > 0 ? seasons[0].id : null

  try {
    await sql`
      INSERT INTO games
        (discord_id, played_at, map_name, game_duration_seconds,
         winner_name, winner_race, loser_name, loser_race,
         winner_apm, loser_apm, replay_file, season_id)
      VALUES
        (${payload.discord_id}, ${payload.played_at}, ${payload.map_name}, ${payload.game_duration_seconds},
         ${payload.winner_name}, ${payload.winner_race}, ${payload.loser_name}, ${payload.loser_race},
         ${payload.winner_apm}, ${payload.loser_apm}, ${payload.replay_file}, ${seasonId})
      ON CONFLICT (replay_file) DO NOTHING
    `
  } catch (e) {
    console.error("DB insert error:", e)
    return new Response(JSON.stringify({ error: "Failed to record game" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})
