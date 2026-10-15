#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
IMAGE_PREFIX="${IMAGE_PREFIX:-gitfoundry-p0}"
PLATFORM="${PLATFORM:-linux/amd64}"
BASE_IMAGE="${IMAGE_PREFIX}-linux-runner:local"
HELPER_IMAGE="${IMAGE_PREFIX}-git-helper:local"
CI_IMAGE="${IMAGE_PREFIX}-ci-runner:local"
NAME="gitfoundry-p0-cancel-$$"

grep_credentials='(TOKEN|SECRET|CREDENTIAL|CLOUDFLARE|ARTIFACTS|GITHUB|GITLAB|DEPLOY|SSH)'

cd "$ROOT"

docker version --format 'docker client={{.Client.Version}} server={{.Server.Version}} os={{.Server.Os}} arch={{.Server.Arch}}'
docker build --platform "$PLATFORM" -t "$BASE_IMAGE" images/linux-runner
docker build --platform "$PLATFORM" -t "$HELPER_IMAGE" -f images/git-helper/Dockerfile images
docker build --platform "$PLATFORM" -t "$CI_IMAGE" -f images/ci-runner/Dockerfile images

docker image inspect "$BASE_IMAGE" "$HELPER_IMAGE" "$CI_IMAGE" --format '{{.RepoTags}} {{.Id}} {{.Architecture}} {{json .Config.Labels}}'
default_index=0
for image in "$BASE_IMAGE" "$HELPER_IMAGE" "$CI_IMAGE"; do
  default_index=$((default_index + 1))
  default_name="gitfoundry-p0-default-$default_index-$$"
  docker rm -f "$default_name" >/dev/null 2>&1 || true
  docker run -d --platform "$PLATFORM" --name "$default_name" "$image" >/dev/null
  sleep 1
  default_running="$(docker inspect -f '{{.State.Running}}' "$default_name")"
  [ "$default_running" = "true" ]
  docker exec "$default_name" /usr/bin/git --version | grep '^git version '
  docker exec "$default_name" /usr/local/bin/gitfoundry-supervise --version | grep '^gitfoundry-supervisor '
  docker rm -f "$default_name" >/dev/null
  if docker ps -a --format '{{.Names}}' | grep -x "$default_name"; then
    echo "default idle container survived destroy: $image" >&2
    exit 1
  fi
  echo "default-idle-running-and-destroyed=$image"
done
uname_value="$(docker run --rm --platform "$PLATFORM" --entrypoint /bin/uname "$HELPER_IMAGE" -m)"
echo "uname=$uname_value"
[ "$uname_value" = "x86_64" ]
docker run --rm --platform "$PLATFORM" --entrypoint git "$HELPER_IMAGE" --version
docker run --rm --platform "$PLATFORM" --entrypoint /usr/local/bin/gitfoundry-supervise "$HELPER_IMAGE" --version
docker run --rm --platform "$PLATFORM" --entrypoint /usr/local/bin/gitfoundry-supervise "$HELPER_IMAGE" --command-id child-version --deadline-ms 30000 --cwd /work/git-version -- /usr/bin/git --version | grep '^git version '

docker run --rm --platform "$PLATFORM" --entrypoint /bin/sh "$HELPER_IMAGE" -c 'dpkg-query -W -f="package=\${Package} version=\${Version}\n" ca-certificates coreutils curl findutils git procps; test -s /usr/share/doc/git/copyright; test -s /usr/share/doc/curl/copyright; echo package-license-files=present'

docker run --rm --platform "$PLATFORM" --entrypoint /usr/local/bin/gitfoundry-supervise "$HELPER_IMAGE" --command-id exact --deadline-ms 30000 -- /usr/local/bin/gitfoundry-git-helper version
git_helper_probe="$(docker run --rm --platform "$PLATFORM" --entrypoint /bin/sh "$HELPER_IMAGE" -c '
set -eu
secret="$(cat /proc/sys/kernel/random/uuid)"
rm -rf /tmp/gitfoundry-helper-src /tmp/gitfoundry-helper-remote.git
mkdir -p /tmp/gitfoundry-helper-src
cd /tmp/gitfoundry-helper-src
git init -q
git config user.email gitfoundry@example.invalid
git config user.name GitFoundry
printf helper-private-transport > README.md
git add README.md
git commit -q -m init
git init -q --bare /tmp/gitfoundry-helper-remote.git
git remote add origin /tmp/gitfoundry-helper-remote.git
git push -q origin HEAD:refs/heads/main
export FIXTURE_OID=$(git rev-parse HEAD)
node <<EOF >/tmp/helper-server.stdout 2>/tmp/helper-server.stderr &
const http = require("node:http");
const packet = text => (Buffer.byteLength(text) + 4).toString(16).padStart(4, "0") + text;
const body = packet("# service=git-upload-pack\n") + "0000" + packet(process.env.FIXTURE_OID + " refs/heads/main\0multi_ack\n") + "0000";
http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement" });
  response.end(body);
}).listen(18479, "127.0.0.1");
EOF
server_pid=$!
trap "kill $server_pid 2>/dev/null || true" EXIT
ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:18479/repo.git/info/refs >/dev/null; then ready=1; break; fi
  sleep 0.1
done
[ "$ready" = 1 ]
workspace=/work/tenant-a/repo-a/op-credential
mkdir -p "$workspace"
cd "$workspace"
helper_status=0
{
  printf "version=1\n"
  printf "tenantId=tenant-a\n"
  printf "repositoryId=repo-a\n"
  printf "providerId=local\n"
  printf "providerRepositoryId=tenant-a/repo-a\n"
  printf "username_b64=%s\n" "$(printf "%s" gitfoundry | base64 | tr -d "\n")"
  printf "password_b64=%s\n" "$(printf "%s" "$secret" | base64 | tr -d "\n")"
} | GFY_HELPER_TEST_MODE=1 /usr/local/bin/gitfoundry-git-helper ls-remote http://127.0.0.1:18479/repo.git refs/heads/main > /tmp/helper.stdout 2> /tmp/helper.stderr || helper_status=$?
cat /tmp/helper.stdout
cat /tmp/helper.stderr
[ "$helper_status" = 0 ]
for file in /tmp/helper.stdout /tmp/helper.stderr; do
  [ -f "$file" ] || continue
  content="$(cat "$file")"
  case "$content" in
    *"$secret"*) echo "credential leaked to $file" >&2; exit 1 ;;
  esac
done
env > /tmp/helper.env
while IFS= read -r envline; do
  case "$envline" in
    *"$secret"*) echo "credential leaked to env" >&2; exit 1 ;;
  esac
done < /tmp/helper.env
for cmdline in /proc/[0-9]*/cmdline; do
  args="$(tr "\000" " " < "$cmdline" 2>/dev/null || true)"
  case "$args" in
    *"$secret"*) echo "credential leaked to argv" >&2; exit 1 ;;
  esac
done
echo helper-credential-output-clean=true
echo helper-credential-env-clean=true
echo helper-credential-argv-clean=true
')"
echo "$git_helper_probe"
printf '%s\n' "$git_helper_probe" | grep 'refs/heads/main'
printf '%s\n' "$git_helper_probe" | grep 'credential-file-mode=600'
printf '%s\n' "$git_helper_probe" | grep 'helper-credential-output-clean=true'
printf '%s\n' "$git_helper_probe" | grep 'helper-credential-env-clean=true'
printf '%s\n' "$git_helper_probe" | grep 'helper-credential-argv-clean=true'
stream_output="$(docker run --rm --platform "$PLATFORM" --entrypoint /bin/sh "$HELPER_IMAGE" -c '/usr/local/bin/gitfoundry-supervise --command-id stream --deadline-ms 30000 --cwd /work/tenant-a/repo-a/op-a/subdir -- /bin/sh -c "printf stdout-visible; printf stderr-visible >&2"; printf "\nfile-stdout="; cat /run/gitfoundry/stream.stdout; printf "\nfile-stderr="; cat /run/gitfoundry/stream.stderr' 2>&1)"
echo "$stream_output"
printf '%s\n' "$stream_output" | grep -E '^(stdout-visiblestderr-visible|stderr-visiblestdout-visible)$'
printf '%s\n' "$stream_output" | grep 'stdout-visible'
printf '%s\n' "$stream_output" | grep 'stderr-visible'
printf '%s\n' "$stream_output" | grep 'file-stdout=stdout-visible'
printf '%s\n' "$stream_output" | grep 'file-stderr=stderr-visible'
docker run --rm --platform "$PLATFORM" --entrypoint /bin/sh "$HELPER_IMAGE" -c 'mkdir -p /tmp/escape; ln -s /tmp/escape /work/link; if /usr/local/bin/gitfoundry-supervise --command-id cwdescape --deadline-ms 30000 --cwd /work/link/subdir -- /bin/pwd; then echo "cwd symlink escape unexpectedly passed" >&2; exit 1; fi; echo cwd-symlink-denied=true'

flood_counts="$(docker run --rm --platform "$PLATFORM" --entrypoint /bin/sh "$HELPER_IMAGE" -c 'timeout 20s /usr/local/bin/gitfoundry-supervise --command-id flood --deadline-ms 30000 -- /bin/sh -c "yes x | head -c 300000" >/tmp/flood.forwarded; file_bytes="$(wc -c < /run/gitfoundry/flood.stdout)"; forwarded_bytes="$(wc -c < /tmp/flood.forwarded)"; echo "$file_bytes $forwarded_bytes"')"
set -- $flood_counts
flood_file_bytes="$1"
flood_forwarded_bytes="$2"
echo "flood-file-bytes=$flood_file_bytes flood-forwarded-bytes=$flood_forwarded_bytes"
[ "$flood_file_bytes" = "300000" ]
[ "$flood_forwarded_bytes" = "300000" ]

docker run --rm --platform "$PLATFORM" --network none --entrypoint /bin/sh "$CI_IMAGE" -c 'if curl -fsS --max-time 2 https://example.com >/tmp/egress 2>&1; then cat /tmp/egress; exit 1; fi; echo egress=denied'
docker run --rm --platform "$PLATFORM" --entrypoint /bin/sh "$CI_IMAGE" -c "if env | grep -Ei '$grep_credentials' >/tmp/credential-hit; then cat /tmp/credential-hit >&2; exit 1; fi; echo credential-scan=empty"
if docker run --rm --platform "$PLATFORM" --entrypoint /bin/sh -e GITHUB_TOKEN=redacted "$CI_IMAGE" -c "if env | grep -Ei '$grep_credentials' >/dev/null; then exit 42; fi"; then
  echo "credential injection unexpectedly passed" >&2
  exit 1
else
  status="$?"
  [ "$status" = "42" ]
  echo "credential-scan-injected=red"
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --platform "$PLATFORM" --name "$NAME" --entrypoint /bin/sh "$CI_IMAGE" -c "setsid sh -c 'sleep 600 &' ; sleep 600" >/dev/null
sleep 1
docker rm -f "$NAME" >/dev/null
if docker ps -a --format '{{.Names}}' | grep -x "$NAME"; then
  echo "dedicated container survived cancellation" >&2
  exit 1
fi
echo "dedicated-container-destroyed=true"

SUCCESS_NAME="gitfoundry-p0-success-cleanup-$$"
docker rm -f "$SUCCESS_NAME" >/dev/null 2>&1 || true
docker run -d --platform "$PLATFORM" --name "$SUCCESS_NAME" --entrypoint /bin/sh "$CI_IMAGE" -c "setsid sh -c 'sleep 600 &' ; /usr/local/bin/gitfoundry-supervise --command-id success --deadline-ms 30000 -- /bin/true; sleep 600" >/dev/null
sleep 1
docker rm -f "$SUCCESS_NAME" >/dev/null
if docker ps -a --format '{{.Names}}' | grep -x "$SUCCESS_NAME"; then
  echo "dedicated container survived successful command cleanup" >&2
  exit 1
fi
echo "success-dedicated-container-destroyed=true"

echo "linux execution image qualification passed"
