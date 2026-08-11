# Unifying Storage

남는 Mac을 팀용 파일 서버와 프로젝트 허브로 바꾸는 작은 웹 애플리케이션입니다.

브라우저에서 파일을 탐색하고, 대용량 파일과 ZIP 데이터셋을 올리고, Git 저장소를 복제하거나 프로젝트 폴더를 만들 수 있습니다. Tailscale Serve 또는 Cloudflare Tunnel을 앞에 두면 공유기 포트를 직접 열지 않고도 HTTPS로 접속할 수 있습니다.

> 이 저장소는 웹 애플리케이션의 소스만 제공합니다. 운영 중인 서버, 파일, 도메인, 인증서와 비밀번호는 포함하지 않습니다.

## 주요 기능

- 공유 볼륨의 파일·폴더 탐색, 검색, 다운로드, 이름 변경 및 삭제
- 일반 파일과 ZIP 폴더 업로드
- 16MB 단위·최대 4개 병렬 업로드와 실시간 속도/남은 시간 표시
- 업로드 취소와 중단된 세션 복구
- ZIP 업로드 후 서버에서 자동 압축 해제
- Git 프로젝트 생성, GitHub 저장소 복제, 변경 상태 확인
- Mac 메모리·가동 시간·디스크·Tailscale·SSH·Colima 상태 표시
- 공용 로그인 화면과 12시간 HttpOnly 세션
- 저장소 밖으로 이동하는 경로 탐색 차단
- 실행 중인 관리 프로젝트 삭제 방지

## 화면 구조

```text
브라우저
   │ HTTPS
   ▼
Cloudflare Tunnel 또는 Tailscale Serve
   │ http://127.0.0.1:8787
   ▼
hub-server.mjs ── 인증·파일 API·업로드 조립
   │
   ├─ vinext UI (127.0.0.1:3000)
   ├─ 프로젝트 폴더
   └─ 공유 저장장치
```

## 요구 사항

- macOS
- Node.js 22.13 이상
- npm
- 외장 SSD 또는 공유할 로컬 폴더
- 선택: Git, Colima, Tailscale, Cloudflare Tunnel

현재 시스템 상태 수집과 ZIP 처리는 `memory_pressure`, `scutil`, `ditto` 등 macOS 기본 도구를 사용합니다. Linux 지원은 아직 제공하지 않습니다.

## 빠른 시작

```bash
git clone https://github.com/yiseowon/unifying-storage.git
cd unifying-storage
npm install
npm run build
```

프로젝트와 공유 저장소 폴더를 준비합니다.

```bash
mkdir -p "$HOME/Developer"
mkdir -p "/Volumes/UnifyingStorage"
```

환경변수를 지정하고 실행합니다.

```bash
export HUB_USER="team"
export HUB_PASSWORD="충분히-긴-임의의-비밀번호"
export HUB_PROJECT_ROOT="$HOME/Developer"
export HUB_SHARED_ROOT="/Volumes/UnifyingStorage"
export HUB_HOST="127.0.0.1"
export HUB_PORT="8787"

npm run hub
```

로컬에서 `http://127.0.0.1:8787`을 열면 됩니다. HTTPS 프록시를 붙이기 전에는 같은 Mac에서만 사용하세요.

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `HUB_USER` | 없음 | 필수 로그인 아이디 |
| `HUB_PASSWORD` | 없음 | 필수 로그인 비밀번호 |
| `HUB_HOME` | 현재 사용자 홈 | 명령 실행 시 사용할 홈 |
| `HUB_PROJECT_ROOT` | `~/Developer` | Git 프로젝트 저장 위치 |
| `HUB_SHARED_ROOT` | `/Volumes/UnifyingStorage` | 파일 공유 루트 |
| `HUB_HOST` | Tailscale IPv4 | API 서버 바인딩 주소 |
| `HUB_PORT` | `8787` | API 서버 포트 |
| `HUB_NPM` | `npm` | 프런트엔드 실행에 사용할 npm 경로 |
| `HUB_GIT` | `/usr/bin/git` | Git 실행 파일 경로 |
| `HUB_COLIMA` | `/opt/homebrew/bin/colima` | Colima 실행 파일 경로 |
| `HUB_NO_FRONTEND` | `0` | `1`이면 API만 실행 |

로그인 정보가 없으면 모든 요청이 거부됩니다. 비밀번호를 저장소나 LaunchAgent 파일에 직접 커밋하지 말고, 운영 환경의 권한이 제한된 설정 파일이나 비밀 관리 기능을 사용하세요.

## Cloudflare Tunnel로 공개하기

팀원이 Tailscale을 설치하지 않아도 접속하게 하려면 Cloudflare Tunnel을 사용할 수 있습니다.

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create unifying-storage
cloudflared tunnel route dns unifying-storage storage.example.com
```

`~/.cloudflared/config.yml` 예시입니다.

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /Users/YOU/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: storage.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
cloudflared tunnel run unifying-storage
```

운영 환경에서는 `cloudflared`와 `npm run hub`를 LaunchAgent로 등록해 로그인 또는 재부팅 후 자동 실행되게 하는 것을 권장합니다.

## Tailscale 안에서만 사용하기

외부 인터넷 공개가 필요 없다면 Funnel 대신 Serve가 더 단순하고 안전합니다.

```bash
tailscale serve --bg http://127.0.0.1:8787
```

이 경우 접속하는 기기도 같은 tailnet에 있어야 합니다.

## 업로드 동작

대용량 파일은 브라우저에서 16MB 조각으로 나뉘어 최대 4개가 병렬 전송됩니다. 서버는 세션 정보를 임시 디스크에 기록하므로 프로세스가 재시작돼도 이미 받은 조각을 다시 찾을 수 있습니다.

ZIP 폴더 업로드는 전송 후 macOS `ditto`로 자동 해제됩니다.

- ZIP 안에 최상위 폴더가 하나면 그 폴더명을 유지합니다.
- 여러 파일이 바로 들어 있으면 ZIP 파일명으로 폴더를 만듭니다.
- 심볼릭 링크와 특수 파일은 거부합니다.
- 같은 이름의 대상이 이미 있으면 덮어쓰지 않고 실패합니다.
- 파일 한 개의 최대 크기는 5GB입니다.

## 개발

```bash
npm run dev
npm run lint
npm test
```

`npm test`는 프로덕션 빌드 후 Node 기본 테스트 러너로 경로 검증, 로그인 세션, 삭제 보호, ZIP 및 병렬 업로드 구조를 확인합니다.

## 보안 주의사항

이 앱은 파일 생성·삭제와 Git 명령을 수행합니다. 인터넷에 공개하기 전에 반드시 다음을 확인하세요.

1. 길고 고유한 `HUB_PASSWORD`를 사용합니다.
2. Cloudflare Tunnel 또는 신뢰할 수 있는 HTTPS 리버스 프록시 뒤에서 실행합니다.
3. `HUB_SHARED_ROOT`와 `HUB_PROJECT_ROOT`에 필요한 데이터만 둡니다.
4. 실행 사용자의 macOS 권한을 최소화합니다.
5. 중요한 데이터는 별도 백업합니다. 웹의 삭제 기능은 휴지통이 아닌 영구 삭제입니다.
6. Tunnel 인증서, JSON 자격증명, `.env` 파일을 Git에 올리지 않습니다.

공용 계정 하나를 함께 쓰는 소규모 팀을 위한 도구입니다. 사용자별 권한, 감사 로그, 멀티테넌시가 필요하다면 별도의 인증·권한 계층을 추가해야 합니다.

## 라이선스

MIT License. 자세한 내용은 [`LICENSE`](LICENSE)를 참고하세요.
