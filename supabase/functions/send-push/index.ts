import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"
import webpush from "web-push"
import { timingSafeEqual } from "node:crypto"

// notifications에 행이 들어가면 DB 트리거(notify_push)가 트랜잭션당 한 번 pg_net으로 이 함수를 부른다.
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

// 한 번에 가져갈 알림 수와 반복 횟수. 함수 실행 시간 안에 끝나도록 상한을 둔다 — 남은 알림은
// DB의 매분 재시도(push-dispatch-retry)가 다시 부른다
const CLAIM_BATCH = 200
const MAX_ROUNDS = 5
// 푸시 서비스로 동시에 보내는 수
const SEND_CONCURRENCY = 20

interface PendingPush {
  id: number
  user_id: number
  type: string
  title: string
  body: string | null
}

interface Subscription {
  id: number
  user_id: number
  endpoint: string
  p256dh: string
  auth: string
}

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

  // 요청 본문은 보지 않는다. 아직 안 보낸 알림을 모두 가져가 보낸다(claim_pending_pushes가 가져가면서
  // push_sent_at을 찍어, 호출이 겹쳐도 같은 알림을 두 번 보내지 않는다). 예전엔 알림 1건마다 호출해
  // 전원에게 가는 알림(캘린더 53건)에서 함수 호출 한도(429)·시간 초과로 절반 넘게 유실됐다
  let sent = 0
  let notifications = 0
  const expired = new Set<number>()

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { data: batch, error: claimError } = await db.rpc("claim_pending_pushes", { p_limit: CLAIM_BATCH })
    if (claimError) {
      console.error("claim failed", claimError)
      return json({ error: "db", sent, notifications }, 500)
    }
    const rows = (batch ?? []) as PendingPush[]
    if (!rows.length) break
    notifications += rows.length

    const userIds = [...new Set(rows.map((n) => n.user_id))]
    const { data: subs, error: subsError } = await db
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth")
      .in("user_id", userIds)
    if (subsError) {
      console.error("subscriptions load failed", subsError)
      return json({ error: "db", sent, notifications }, 500)
    }

    const subsByUser = new Map<number, Subscription[]>()
    for (const s of (subs ?? []) as Subscription[]) {
      subsByUser.set(s.user_id, [...(subsByUser.get(s.user_id) ?? []), s])
    }

    // 내용은 요청이 아니라 DB에서 읽는다 — 호출하는 쪽이 문구를 정할 수 없게
    const jobs = rows.flatMap((n) => (subsByUser.get(n.user_id) ?? []).map((s) => ({ n, s })))
    for (let i = 0; i < jobs.length; i += SEND_CONCURRENCY) {
      await Promise.all(jobs.slice(i, i + SEND_CONCURRENCY).map(async ({ n, s }) => {
        if (expired.has(s.id)) return
        const payload = JSON.stringify({
          title: n.title,
          body: n.body ?? "",
          url: urlFor(n.type),
          // 같은 알림이 재시도로 두 번 와도 기기에는 하나만 남게
          tag: `notification-${n.id}`,
        })
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
          if (status === 404 || status === 410) expired.add(s.id)
          else console.error("push send failed", status, (e as Error).message)
        }
      }))
    }
  }

  if (expired.size) {
    await db.from("push_subscriptions").delete().in("id", [...expired])
  }

  return json({ sent, notifications, expired: expired.size })
})
