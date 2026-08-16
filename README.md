# Unifying Storage

남는 Mac을 팀용 파일 서버와 프로젝트 허브로 바꾸는 작은 웹 애플리케이션입니다.

브라우저에서 파일을 탐색하고, 대용량 파일과 ZIP 데이터셋을 올리고, Git 저장소를 복제하거나 프로젝트 폴더를 만들 수 있습니다. Tailscale Serve 또는 Cloudflare Tunnel을 앞에 두면 공유기 포트를 직접 열지 않고도 HTTPS로 접속할 수 있습니다.

> 이 저장소는 웹 애플리케이션의 소스만 제공합니다. 운영 중인 서버, 파일, 도메인, 인증서와 비밀번호는 포함하지 않습니다.

## 주요 기능

- 공유 볼륨의 파일·폴더 탐색, 검색, 다운로드, 이름 변경 및 삭제
- 일반 파일과 ZIP 폴더 업로드
- 32MB 단위·파일 10개 × 파일당 3조각 병렬 업로드와 파일별 진행 상태 표시
- 업로드 취소와 중단된 세션 복구
- ZIP 업로드 후 서버에서 자동 압축 해제
- Git 프로젝트 생성, GitHub 저장소 복제, 변경 상태 확인
- Mac 메모리·가동 시간·디스크·Tailscale·SSH·Colima 상태 표시
- Cloudflare 공개 주소·Docker 컨테이너·TCP 리스닝 포트 호스팅 현황
- 공용 로그인 화면과 12시간 HttpOnly 세션
- 저장소 밖으로 이동하는 경로 탐색 차단
- 실행 중인 관리 프로젝트 삭제 방지
- 폴더별 읽기/쓰기 API 키 발급·폐기
- 대용량 데이터셋용 HTTP Range 스트리밍 API

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

최초 1회, 터미널에 표시되지 않는 비밀번호를 입력해 `Administrator` 계정을 만듭니다.

```bash
read -s HUB_ADMIN_PASSWORD
printf %s "$HUB_ADMIN_PASSWORD" | node hub-server.mjs --setup-admin
unset HUB_ADMIN_PASSWORD
```

환경변수를 지정하고 실행합니다.

```bash
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
| `HUB_HOME` | 현재 사용자 홈 | 명령 실행 시 사용할 홈 |
| `HUB_PROJECT_ROOT` | `~/Developer` | Git 프로젝트 저장 위치 |
| `HUB_SHARED_ROOT` | `/Volumes/UnifyingStorage` | 파일 공유 루트 |
| `HUB_HOST` | Tailscale IPv4 | API 서버 바인딩 주소 |
| `HUB_PORT` | `8787` | API 서버 포트 |
| `HUB_NPM` | `npm` | 프런트엔드 실행에 사용할 npm 경로 |
| `HUB_GIT` | `/usr/bin/git` | Git 실행 파일 경로 |
| `HUB_COLIMA` | `/opt/homebrew/bin/colima` | Colima 실행 파일 경로 |
| `HUB_DOCKER` | `/opt/homebrew/bin/docker` | Docker 실행 파일 경로 |
| `HUB_LSOF` | `/usr/sbin/lsof` | TCP 리스너 확인 명령 경로 |
| `HUB_CLOUDFLARE_CONFIG` | `~/.cloudflared/config.yml` | 공개 호스트명과 로컬 서비스 매핑 위치 |
| `HUB_NO_FRONTEND` | `0` | `1`이면 API만 실행 |
| `HUB_API_KEYS_FILE` | `~/.unifying-storage/api-keys.json` | API 키 해시와 폴더 연결 정보 저장 위치 |
| `HUB_ADMIN_FILE` | `~/.unifying-storage/admin.json` | Administrator 비밀번호 해시와 세션 키 저장 위치 |

관리자 설정 파일은 권한 `0600`으로 생성되며 비밀번호 원문을 저장하지 않습니다. 파일이 없거나 잘못되면 서버는 시작되지 않습니다.

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

대용량 파일은 브라우저에서 32MB 조각으로 나뉘며, 최대 10개 파일을 동시에 파일당 3조각씩 전송합니다. 서버는 세션 정보를 임시 디스크에 기록하므로 프로세스가 재시작돼도 이미 받은 조각을 다시 찾을 수 있습니다.

ZIP 폴더 업로드는 전송 후 macOS `ditto`로 자동 해제됩니다.

- ZIP 안에 최상위 폴더가 하나면 그 폴더명을 유지합니다.
- 여러 파일이 바로 들어 있으면 ZIP 파일명으로 폴더를 만듭니다.
- 심볼릭 링크와 특수 파일은 거부합니다.
- 같은 이름의 대상이 이미 있으면 덮어쓰지 않고 실패합니다.
- 앱이 정한 파일 용량 제한은 없습니다. 실제 한계는 공유 저장장치의 남은 용량과 파일시스템에 따릅니다.

## 폴더 API 사용 설명서

폴더별 API를 사용하면 팀원의 Python 코드나 서버가 브라우저를 거치지 않고 데이터셋에 접근할 수 있습니다. 별도의 서버 비밀번호를 코드에 넣을 필요는 없습니다. 공개 HTTPS 주소와 폴더 ID, 폴더 API 키 세 가지만 사용합니다.

### 1. API 키 발급

1. 관리자 계정으로 Unifying Storage 웹에 로그인합니다.
2. 공유 저장소에서 데이터셋 폴더 오른쪽의 열쇠 아이콘을 누릅니다.
3. 키 이름과 권한을 선택하고 **새 키 발급**을 누릅니다.
4. 표시된 `us_live_...` 키와 Folder ID를 즉시 복사합니다.

키 원문은 발급 직후 한 번만 표시됩니다. 서버에는 키의 SHA-256 해시만 저장되므로 잃어버렸다면 기존 키를 폐기하고 새로 발급해야 합니다.

권한은 두 종류입니다.

| 권한 | 가능한 작업 |
| --- | --- |
| 읽기 전용 | 폴더 목록, 파일 다운로드, Range 요청 |
| 읽기·쓰기·삭제 | 읽기 작업, 새 파일 업로드, 파일·하위 폴더 삭제 |

팀원이나 실행 서버마다 키를 따로 발급하세요. 키가 유출되면 해당 키만 폐기할 수 있습니다.

### 2. 환경변수 설정

API 키를 Git 저장소의 소스 코드나 `.env` 파일에 커밋하면 안 됩니다. 셸 또는 배포 서비스의 Secret 기능에 등록하세요.

```bash
export STORAGE_URL="https://storage.example.com"
export STORAGE_FOLDER_ID="발급된-Folder-ID"
export STORAGE_API_KEY="us_live_발급된_API_키"
```

`.env`를 사용한다면 반드시 `.gitignore`에 포함되어 있는지 확인합니다. 이 저장소는 기본적으로 `.env*`를 무시합니다.

### 3. 파일 목록 보기

루트 목록:

```bash
curl -H "Authorization: Bearer $STORAGE_API_KEY" \
  "$STORAGE_URL/api/v1/folders/$STORAGE_FOLDER_ID/files"
```

하위 폴더 목록:

```bash
curl -H "Authorization: Bearer $STORAGE_API_KEY" \
  "$STORAGE_URL/api/v1/folders/$STORAGE_FOLDER_ID/files/train/images"
```

응답 예시:

```json
{
  "folderId": "b19a96f4-7e78-4f86-95b1-7bfe0eb5cb1a",
  "path": "train",
  "entries": [
    { "name": "labels.csv", "path": "train/labels.csv", "directory": false, "size": 42010 }
  ]
}
```

### 4. 파일 다운로드

```bash
curl -L \
  -H "Authorization: Bearer $STORAGE_API_KEY" \
  "$STORAGE_URL/api/v1/folders/$STORAGE_FOLDER_ID/files/train/labels.csv" \
  -o labels.csv
```

대용량 다운로드를 이어받으려면 `-C -`를 추가합니다. 서버는 `Range`와 `HEAD` 요청을 지원합니다.

```bash
curl -C - -L \
  -H "Authorization: Bearer $STORAGE_API_KEY" \
  "$STORAGE_URL/api/v1/folders/$STORAGE_FOLDER_ID/files/model.bin" \
  -o model.bin
```

### 5. Python에서 데이터셋 사용

추가 라이브러리 없이 파일을 내려받는 예시입니다.

```python
import os
from pathlib import Path
from urllib.request import Request, urlopen

base = os.environ["STORAGE_URL"]
folder_id = os.environ["STORAGE_FOLDER_ID"]
api_key = os.environ["STORAGE_API_KEY"]
remote_path = "train/labels.csv"

request = Request(
    f"{base}/api/v1/folders/{folder_id}/files/{remote_path}",
    headers={"Authorization": f"Bearer {api_key}"},
)

with urlopen(request, timeout=60) as response:
    Path("labels.csv").write_bytes(response.read())
```

`pandas`로 바로 읽을 때는 인증 헤더를 전달할 수 있는 `requests`를 함께 사용합니다.

```python
import io
import os
import pandas as pd
import requests

url = (
    f"{os.environ['STORAGE_URL']}/api/v1/folders/"
    f"{os.environ['STORAGE_FOLDER_ID']}/files/train/labels.csv"
)
response = requests.get(
    url,
    headers={"Authorization": f"Bearer {os.environ['STORAGE_API_KEY']}"},
    timeout=60,
)
response.raise_for_status()
dataset = pd.read_csv(io.BytesIO(response.content))
```

### 6. 파일 업로드와 삭제

쓰기 권한 키가 필요합니다. 중간 폴더가 없으면 업로드 시 자동 생성됩니다. 기존 파일은 실수로 덮어쓰지 않습니다.

```bash
curl -X PUT \
  -H "Authorization: Bearer $STORAGE_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @result.csv \
  "$STORAGE_URL/api/v1/folders/$STORAGE_FOLDER_ID/files/results/result.csv"
```

```bash
curl -X DELETE \
  -H "Authorization: Bearer $STORAGE_API_KEY" \
  "$STORAGE_URL/api/v1/folders/$STORAGE_FOLDER_ID/files/results/result.csv"
```

### 7. 키 폐기

웹의 열쇠 아이콘을 다시 누르고 대상 키의 **폐기**를 누릅니다. 폐기 즉시 해당 키를 사용하는 모든 요청이 거부됩니다.

### API 주소 요약

| 메서드 | 주소 | 설명 |
| --- | --- | --- |
| `GET` | `/api/v1/folders/:folderId/files` | 폴더 루트 목록 |
| `GET` | `/api/v1/folders/:folderId/files/*` | 하위 목록 또는 파일 스트리밍 |
| `HEAD` | `/api/v1/folders/:folderId/files/*` | 파일 크기·Range 확인 |
| `PUT` | `/api/v1/folders/:folderId/files/*` | 새 파일 업로드 |
| `DELETE` | `/api/v1/folders/:folderId/files/*` | 파일 또는 하위 폴더 삭제 |

모든 요청은 `Authorization: Bearer us_live_...` 헤더가 필요합니다. 브라우저 관리자 로그인 비밀번호는 이 API에서 사용하지 않습니다.

## 개발

```bash
npm run dev
npm run lint
npm test
```

`npm test`는 프로덕션 빌드 후 Node 기본 테스트 러너로 경로 검증, 로그인 세션, 삭제 보호, ZIP 및 병렬 업로드 구조를 확인합니다.

## 보안 주의사항

이 앱은 파일 생성·삭제와 Git 명령을 수행합니다. 인터넷에 공개하기 전에 반드시 다음을 확인하세요.

1. 길고 고유한 Administrator 비밀번호를 사용합니다.
2. Cloudflare Tunnel 또는 신뢰할 수 있는 HTTPS 리버스 프록시 뒤에서 실행합니다.
3. `HUB_SHARED_ROOT`와 `HUB_PROJECT_ROOT`에 필요한 데이터만 둡니다.
4. 실행 사용자의 macOS 권한을 최소화합니다.
5. 중요한 데이터는 별도 백업합니다. 웹의 삭제 기능은 휴지통이 아닌 영구 삭제입니다.
6. Tunnel 인증서, JSON 자격증명, `.env` 파일을 Git에 올리지 않습니다.

단일 `Administrator` 계정으로 운영하는 개인 서버용 도구입니다. 사용자별 권한, 감사 로그, 멀티테넌시가 필요하다면 별도의 인증·권한 계층을 추가해야 합니다.

## 라이선스

MIT License. 자세한 내용은 [`LICENSE`](LICENSE)를 참고하세요.
