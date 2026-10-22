# badak-tier-park-api — Claude 작업 지침

바닥티어 Supabase Edge Functions(Deno/TypeScript).
**이 문서에는 코드에서 확인할 수 없는 내용만 적는다.**

## 함수와 호출하는 쪽
| 함수 | 호출하는 곳 | 비고 |
|------|-------------|------|
| `record-game` | gg-tracker (`/functions/v1/record-game`) | 리플레이 전적을 `games`에 기록. 가장 최근 시즌(`seasons` 최대 id)에 붙인다 |
| `get-games` | gg-tracker 대시보드 | 전적 조회 |
| `notify-entry` | badak-web 엔트리 제출(`src/lib/notifications.ts`) | 디스코드 웹훅으로 알림. 실패해도 웹은 사용자에게 알리지 않는다 |

- **요청·응답 형식을 바꾸면 호출하는 쪽이 같이 바뀌어야 한다.** gg-tracker는 사용자가 받아 둔 실행 파일이라
  옛 버전이 계속 호출한다 — 필드를 빼거나 이름을 바꾸지 말고 추가만 하거나, 옛 형식도 받게 둔다
- `games.map_name`은 웹에서 `maps.name`/`aliases`와 **텍스트로** 매칭된다. 함수에서 맵 이름을 가공하지 않는다

## 조직 저장소 지도
바닥티어는 저장소 여러 개가 **같은 Supabase 프로젝트를 함께 쓴다**(운영 `badak`, 개발 `badak-dev`).
한 저장소에서 테이블·정책을 바꾸면 다른 저장소가 깨질 수 있으니, DB를 건드릴 땐 아래 사용처를 먼저 본다.
공개 저장소이므로 project ID는 문서에 쓰지 않고 Supabase MCP의 `list_projects`로 조회한다.

| 저장소 | 역할 | 배포 | DB와의 관계 |
|--------|------|------|-------------|
| `badak-web` | 웹앱(리그·팀배틀·토너먼트·대시보드·관리) | Vercel (`main`=운영) | 대부분의 테이블을 읽고 쓴다 |
| `badak-bot` | 디스코드 봇(`/유저등록` 등) | EC2 (`main` 푸시 시) | `users` 등록 — 웹은 여기 등록된 사용자만 로그인 가능 |
| `gg-tracker` | 리플레이 감시 데스크톱 앱(Go) | GitHub Release (`main` 푸시 시) | `record-game` 함수로 `games`에 전적 기록 |
| `badak-tier-park-api` | Supabase Edge Functions | `supabase functions deploy` | `record-game`·`get-games`(gg-tracker), `notify-entry`(웹의 엔트리 제출 → 디스코드) |
| `.github` | 조직 프로필·공통 이슈/PR 템플릿 | — | — |

로컬에서는 `~/dev/badak-tier-park/<저장소>`에 나란히 둔다.

## 배포
- `main`에 병합해도 자동 배포되지 않는다. Supabase CLI로 **개발(`badak-dev`) → 운영(`badak`) 순서로 양쪽 모두** 올린다
  (`npx supabase functions deploy <함수> --project-ref <ref>`, ref는 Supabase MCP `list_projects`로 조회 — 문서에 쓰지 않는다)
- 함수 시크릿(`POSTGRES_URL`, `APP_SECRET`, `DISCORD_WEBHOOK_URL`)은 프로젝트마다 따로 `supabase secrets set`으로 둔다.
  `APP_SECRET`은 gg-tracker 빌드에 들어가는 값과 같아야 한다
- 배포했으면 "확인했다"가 아니라 실제 호출해서 응답을 본다(개발 프로젝트에서)

## 커밋 전 검증
테스트는 없다. 함수 디렉토리마다 타입 검사가 통과해야 커밋한다(각 `deno.json`의 import map을 쓰므로 그 디렉토리에서 실행):
```
cd supabase/functions && for d in */; do (cd "$d" && deno check index.ts) || break; done
```

## GitHub 작업 규칙
조직 공통 규칙의 원본은 `badak-web/CLAUDE.md`의 "Git" 섹션이다. 이 저장소에 해당하는 것만 추린다.

- 브랜치: 이 저장소는 `dev` 없이 `main` 하나다. `feat/`·`fix/`·`docs/`·`chore/` 등 작업 브랜치 → `main`으로 PR.
  `main`에 병합돼도 자동 배포되지 않는다(아래 "배포"대로 직접 올린다)
- PR 제목은 커밋과 같은 형식(`feat: …`). 템플릿은 조직 공통(`badak-tier-park/.github`)
- Assignees = 작성자, Reviewers = 작성자 외 쓰기 권한자 전원
  (`gh api repos/badak-tier-park/<저장소>/collaborators --jq '.[].login'`), 종류 Labels,
  관련 이슈는 본문 `Closes #n`. 이 저장소에는 badak-web 같은 PR 자동 설정 워크플로가 없어 직접 채운다
- 보호 규칙이 없다. 그래도 PR과 리뷰를 거친다 — 함수는 웹·gg-tracker가 운영 중에 호출한다

---

## 전역 개발 규칙 (사용자 전역 CLAUDE.md 복사본)
`~/.claude/CLAUDE.md`는 특정 PC에만 있어 다른 기기에서는 보이지 않으므로 여기에 복사해 둔다.
프로젝트에 국한되지 않는 새 규칙이 생기면 여기와 전역 파일 **양쪽에** 반영한다.
위 프로젝트 규칙과 겹치면 위(프로젝트) 서술이 우선한다.

### 커밋 컨벤션
**Conventional Commits**: `<type>(<scope>): <subject>` — scope는 선택.
- type: `feat` · `fix` · `docs` · `test` · `refactor` · `chore` · `style` · `perf`
- subject는 명령형 한 줄, 끝에 마침표 없음
- 본문은 "무엇"이 아니라 **"왜"**를 설명할 때만 쓴다

### 커밋 전 검증
typecheck·lint·test가 통과하는 상태에서 커밋한다. 명령은 프로젝트마다 다르니
CLAUDE.md·package.json scripts·CI에서 확인한다(이 저장소의 명령은 위 "커밋 전 검증").

### 이슈 정리
이슈를 닫기 전에 하위 이슈(sub-issue) 상태를 확인한다. 하위가 하나라도 열려 있으면
상위는 닫지 않는다. 해결 근거를 코드·커밋에서 확인하지 못한 이슈는 닫지 말고 사용자에게 묻는다.

### PR 작성
- Assignees에 작성자, Reviewers에 작성자를 뺀 팀원 전원, 종류·영역 Labels, 관련 이슈는 본문 `Closes #n`으로
  Development에 연결, 프로젝트를 쓰면 Projects에도 넣는다. 저장소에 자동화가 있어도 `gh pr create`로
  직접 올릴 때는 `--assignee @me --reviewer … --label …`로 채운다(자동화가 안 도는 경우가 있다)
- PR 템플릿이 있으면 그 섹션 구조를 따른다. 하지 않은 테스트는 체크하지 않고, 확인하지 못한 것은 적는다

### 문서 계층
- 루트 CLAUDE.md는 매 세션 로드되므로 전역 규칙과 "놓치면 버그가 되는" 요약만 둔다
- 기능별 상세는 그 디렉토리의 CLAUDE.md에 두고, 루트에 **문서 지도**로 위치를 적는다
- 하위 문서는 그 디렉토리 파일을 열 때만 로드된다 — 다른 디렉토리에서 그 기능을 건드릴 땐
  직접 읽어야 하므로 루트에 요약과 경로를 남긴다
- 코드·git 이력으로 알 수 있는 것은 적지 않는다. 코드로 알 수 없는 "왜"와 도메인 룰만 적는다
