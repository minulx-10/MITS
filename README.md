# ⛏ MITS — Minecraft 서버 관리 패널 (GSMSV)

GSMSV(Ubuntu VPS)에서 **tmux로 24시간 돌아가는 PaperMC 서버 2대**(`server1`/`server2`)를
브라우저에서 관리하는 가벼운 웹 패널입니다. `main` 브랜치에 push하면 **GitHub Actions가
GSMSV에 자동 배포**합니다.

> 이 프로젝트는 Aternos → GSMSV 서버 이관 가이드(PDF)의 마지막 단계 — "웹 관리 패널을
> 만들어 CI/CD로 자동 배포" — 를 실제로 구현한 것입니다.

---

## ✨ 기능 (Aternos 10개 메뉴를 자체호스팅으로 재현)

| 탭 | 기능 | Aternos 대응 |
|---|---|---|
| **대시보드** | 상태/포트/메모리, 시작·정지·재시작, 전체 제어, 접속정보 복사 | 서버 |
| **콘솔** | 실시간 콘솔 + 명령 입력 + 도움말(OP/Unban/Gamemode) | 콘솔 |
| **로그** | `latest.log` 보기 + **mclo.gs 공유** 링크 | 서버 기록 |
| **플레이어** | 화이트리스트·OP·차단(플레이어/IP)·접속기록 조회 및 추가/해제 | 플레이어 |
| **소프트웨어** | 현재 Paper 버전 표시 + **PaperMC API로 버전 교체** | 소프트웨어 |
| **플러그인** | 설치 목록/활성·비활성/삭제, `.jar` 업로드, **Modrinth 검색·설치** | 애드온 |
| **파일** | 웹 파일관리자(탐색/편집/업로드/다운로드/삭제/새폴더) | 파일 |
| **월드** | 월드 `.zip` 다운로드/업로드, 초기화, 용량 표시 | 세계 |
| **백업** | 월드 `.tar.gz` 백업 생성/복구/삭제/다운로드 + 자동백업 | 백업 |
| **액세스** | 관리자/뷰어 2단계 비밀번호(읽기전용 공유) | 액세스 |

- **로그인 보호** — 비밀번호 + 세션 쿠키, 기본 `127.0.0.1` 바인딩(외부 미노출)
- **권한 분리** — 관리자(전체) / 뷰어(읽기전용). 모든 쓰기/제어 API는 관리자만 호출 가능

### 자체호스팅 대체 항목
- **Blueprints(테마 맵)** → 없음. **월드 업로드**로 대체.
- **구글드라이브 백업** → 서버 내 `~/mits-backups` 보관 + 다운로드로 대체.
- **계정 초대 권한** → `PANEL_VIEWER_PASSWORD`(뷰어 비밀번호)로 대체.
- **월드 다운로드 형식** → Aternos는 `.zip`, 백업은 `.tar.gz`(둘 다 지원).

---

## 🏗 동작 방식

패널(Node/Express)은 GSMSV에서 **`ubuntu` 사용자**로 `systemd` 서비스(`mits`)로 떠서,
이미 가동 중인 `mc1`/`mc2` **tmux 세션과 같은 소켓**(`/tmp/tmux-<uid>/default`)을 공유합니다.
그래서 별도 연동 없이 다음 명령으로 서버를 제어합니다.

| 동작 | 명령 |
|---|---|
| 상태 | `tmux has-session` + `ss -tlnpH`(포트 LISTEN/PID) + `/proc/<pid>/status`(RSS) |
| 시작 | `tmux new-session -d -s <s>` → `send-keys "cd ~/serverN && java -Xms3G -Xmx3G -jar paper.jar nogui" ENTER` |
| 정지 | `tmux send-keys -t <s> "stop" ENTER` (월드 안전 저장) |
| 콘솔 | `tmux capture-pane -p -t <s>` |
| 명령 | `tmux send-keys -t <s> "<cmd>" ENTER` |

기본 구성(`src/config.js`, `.env`로 오버라이드 가능):

| 서버 | tmux 세션 | 디렉터리 | 내부 포트 |
|---|---|---|---|
| `server1` (1번) | `mc1` | `~/server1` | `25565` |
| `server2` (2번) | `mc2` | `~/server2` | `25566` |

---

## 🚀 배포 (GitHub Actions → GSMSV)

`main` push 또는 수동 실행(`workflow_dispatch`) 시 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)이
`appleboy/ssh-action`으로 GSMSV에 접속해 다음을 **멱등적으로** 수행합니다.

1. `git`/`curl`/`node`(없으면 NodeSource로 Node 22) 설치
2. `~/MITS` clone 또는 `git reset --hard origin/main`
3. `npm ci --omit=dev`
4. 시크릿으로 `~/MITS/.env` 생성
5. `mits.service` 등록 → `systemctl restart mits` → `/api/me` 헬스체크

### 필요한 GitHub 시크릿 (`minulx-10/MITS`)

| 시크릿 | 설명 |
|---|---|
| `SERVER_PASSWORD` | GSMSV SSH 비밀번호 (`ubuntu@ssh.gsmsv.site:24160`) |
| `PANEL_PASSWORD` | 패널 로그인 비밀번호 |
| `SESSION_SECRET` | 세션 서명 시크릿 (랜덤 hex) |

```bash
gh secret set SERVER_PASSWORD --repo minulx-10/MITS
gh secret set PANEL_PASSWORD  --repo minulx-10/MITS
gh secret set SESSION_SECRET  --repo minulx-10/MITS
```

> push 트리거만 사용하므로 public 레포라도 포크 PR에서 시크릿이 노출되지 않습니다.

---

## 🔌 접속 (SSH 터널)

패널은 보안을 위해 `127.0.0.1:3000`에만 바인딩됩니다. 로컬 PC에서 터널을 연 뒤 접속하세요.

```bash
ssh -p 24160 -L 8080:127.0.0.1:3000 ubuntu@ssh.gsmsv.site
# 이후 브라우저에서:  http://localhost:8080
```

---

## 🧪 로컬 개발

```bash
npm install
cp .env.example .env      # PANEL_PASSWORD 등 수정
npm start                 # http://127.0.0.1:3000
```

> tmux가 없는 환경(예: Windows)에서도 패널은 뜨며, 서버 상태는 "정지됨"으로 표시됩니다.
> 실제 제어/콘솔은 GSMSV(tmux 존재)에서 동작합니다.

---

## 🛠 서버 측 운영 명령

```bash
sudo systemctl status mits      # 패널 상태
sudo systemctl restart mits     # 패널 재시작
sudo journalctl -u mits -f      # 패널 로그
tmux ls                         # mc1 / mc2 세션 확인
```

---

## 📁 구조

```
MITS/
├─ server.js                  # Express 엔트리 + API 라우트
├─ src/
│  ├─ config.js               # 서버/패널 설정 (env 오버라이드)
│  ├─ minecraft.js            # tmux 제어 헬퍼
│  ├─ system.js               # 시스템 리소스 조회
│  └─ auth.js                 # 로그인/세션
├─ public/                    # 로그인 + 대시보드 (바닐라, 빌드 불필요)
├─ scripts/
│  ├─ start.sh / stop.sh      # 전체 시작·정지 (서버 실측본)
│  └─ mits.service            # systemd 유닛
└─ .github/workflows/deploy.yml
```

---

## 🔐 보안 메모

- 패널은 서버를 제어하므로 **외부에 직접 노출하지 마세요**(기본 localhost + SSH 터널).
- 비밀번호는 GitHub 시크릿/서버 `.env`에만 두고 레포에 커밋하지 않습니다(`.gitignore`).
- 하드닝: SSH 비밀번호 대신 배포용 SSH 키 + 리버스 프록시(HTTPS, fail2ban) 적용 권장.
