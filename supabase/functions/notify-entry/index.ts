import "@supabase/functions-js/edge-runtime.d.ts"

const WEBHOOK_URL = Deno.env.get("DISCORD_WEBHOOK_URL")

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS })
  }

  if (!WEBHOOK_URL) {
    console.error("DISCORD_WEBHOOK_URL secret is not set")
    return json({ error: "Webhook not configured" }, 500)
  }

  let body: {
    leagueName: string
    teamName: string
    matchRound: string
    matchDate: string | null
    submittedAt: string
  }

  try {
    body = await req.json()
  } catch {
    return json({ error: "Invalid JSON" }, 400)
  }

  const { leagueName, teamName, matchRound, matchDate, submittedAt } = body

  const message = {
    embeds: [
      {
        title: "📋 엔트리 제출 완료",
        color: 0xaa3bff,
        fields: [
          { name: "리그", value: leagueName ?? "-", inline: false },
          { name: "팀", value: teamName ?? "-", inline: true },
          { name: "경기", value: matchRound ?? "-", inline: true },
          { name: "경기 날짜", value: matchDate ? matchDate.replaceAll("-", "/") : "날짜 미정", inline: true },
        ],
        footer: {
          text: submittedAt ?? new Date().toISOString(),
        },
      },
    ],
  }

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error("Discord webhook error:", res.status, text)
      return json({ error: "Discord webhook failed", detail: text }, 502)
    }

    return json({ ok: true })
  } catch (e) {
    console.error("Fetch error:", e)
    return json({ error: String(e) }, 500)
  }
})
