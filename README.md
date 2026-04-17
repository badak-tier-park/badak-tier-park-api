# badak-tier-park-api

Supabase Edge Functions for GG Tracker.

## Edge Functions

| Function      | Method | Description |
|---------------|--------|-------------|
| `record-game` | POST   | 리플레이 데이터 수신 후 DB INSERT 
| `get-games`   | GET    | 전적 목록 조회 (`?limit=N`, `?replay_file=...`) 

## CLI 명령어

### 로그인
```bash
npx supabase login --token <access_token>
```

### Edge Function 배포
```bash
npx supabase functions deploy record-game
npx supabase functions deploy get-games
npx supabase functions deploy notify-entry
```

### Secrets 관리
```bash
# 시크릿 등록
npx supabase secrets set POSTGRES_URL="postgresql://..."

# 등록된 시크릿 목록 확인
npx supabase secrets list
```
