import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"
import webpush from "web-push"
import { timingSafeEqual } from "node:crypto"

// notifications에 행이 들어가면 DB 트리거(notify_push)가 pg_net으로 이 함수를 부른다.
// 비밀값(웹훅 비밀값·VAPID 키)은 함수 시크릿이 아니라 DB Vault에 있고 service_role로만 읽힌다

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
// 푸시 서비스가 문제 있을 때 연락할 주소(VAPID 규격상 필수)
const VAPID_SUBJECT = "https://badak-web.vercel.app"

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

interface PushConfig {
  webhook_secret: string | null
  vapid_public: string | null
  vapid_private: string | null
}

let cached: PushConfig | null = null

async function loadConfig(): Promise<PushConfig> {
  if (cached?.vapid_private) return cached
  const { data, error } = await db.rpc("get_push_config")
  if (error) throw error
  let config = data as PushConfig

  // 첫 실행 때 VAPID 키를 만든다. 개인키가 이 함수와 Vault 밖으로 나가지 않게 하기 위함.
  // 동시에 여러 요청이 와도 init_push_vapid가 먼저 들어간 키만 남기므로 다시 읽어 그 값을 쓴다
  if (!config.vapid_private) {
    const keys = webpush.generateVAPIDKeys()
    const { error: initError } = await db.rpc("init_push_vapid", {
      p_public: keys.publicKey,
      p_private: keys.privateKey,
    })
    if (initError) throw initError
    const { data: again, error: againError } = await db.rpc("get_push_config")
    if (againError) throw againError
    config = again as PushConfig
  }

  cached = config
  return config
}

function sameSecret(given: string | null, expected: string | null): boolean {
  if (!given || !expected) return false
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// 알림을 눌렀을 때 열 화면
function urlFor(type: string): string {
  if (type.startsWith("prediction_")) return "/participate?tab=predictions"
  return "/"
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

Deno.serve(async (req) => {
  let config: PushConfig
  try {
    config = await loadConfig()
  } catch (e) {
    console.error("push config load failed", e)
    return json({ error: "config" }, 500)
  }

  // GET: 공개키 확인용. 배포 직후 한 번 불러 VAPID 키를 만들어 두면 웹이 바로 구독할 수 있다
  if (req.method === "GET") {
    return json({ publicKey: config.vapid_public })
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 })
  }

  if (!sameSecret(req.headers.get("x-push-secret"), config.webhook_secret)) {
    return json({ error: "unauthorized" }, 401)
  }

  let notificationId: number
  try {
    const body = await req.json()
    notificationId = Number(body.notification_id)
    if (!Number.isInteger(notificationId)) throw new Error("notification_id")
  } catch {
    return json({ error: "bad request" }, 400)
  }

  // 내용은 요청이 아니라 DB에서 읽는다 — 호출하는 쪽이 문구를 정할 수 없게
  const { data: notif, error: notifError } = await db
    .from("notifications")
    .select("id, user_id, type, title, body")
    .eq("id", notificationId)
    .maybeSingle()
  if (notifError) {
    console.error("notification load failed", notifError)
    return json({ error: "db" }, 500)
  }
  if (!notif) return json({ sent: 0, reason: "not found" })

  const { data: subs, error: subsError } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", notif.user_id)
  if (subsError) {
    console.error("subscriptions load failed", subsError)
    return json({ error: "db" }, 500)
  }
  if (!subs?.length) return json({ sent: 0 })

  const payload = JSON.stringify({
    title: notif.title,
    body: notif.body ?? "",
    url: urlFor(notif.type),
    // 같은 알림이 재시도로 두 번 와도 기기에는 하나만 남게
    tag: `notification-${notif.id}`,
  })

  let sent = 0
  const expired: number[] = []
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        {
          vapidDetails: { subject: VAPID_SUBJECT, publicKey: config.vapid_public!, privateKey: config.vapid_private! },
          TTL: 60 * 60 * 24,
        },
      )
      sent++
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      // 404/410: 사용자가 권한을 끄거나 앱을 지워 더는 없는 구독
      if (status === 404 || status === 410) expired.push(s.id)
      else console.error("push send failed", status, (e as Error).message)
    }
  }))

  if (expired.length) {
    await db.from("push_subscriptions").delete().in("id", expired)
  }

  return json({ sent, expired: expired.length })
})
