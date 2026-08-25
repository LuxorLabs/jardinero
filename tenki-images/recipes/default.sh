# The default worker toolchain: what a repository runs when it has no recipe of its own.
#
# Node, gh, git and Codex come from the base setup; this adds the runtimes a repository
# we have not onboarded is most likely to need. Nothing here can be anchored to a repo's
# sources the way every other recipe is, so each runtime installs a floor and keeps its
# own way up: Go leaves GOTOOLCHAIN on auto so a newer `go` directive downloads its own
# toolchain, uv can fetch another interpreter at run time, and corepack switches pnpm to
# whatever `packageManager` names. A repository whose gate needs more than that is one
# that has earned its own recipe.

GO_VERSION=1.24.0
UV_VERSION=0.12.5
PYTHON_VERSION=3.13

# `make` drives the gate in most of our repositories and the base setup does not carry it.
as_root apt-get update
as_root apt-get install -y make

curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" -o /tmp/go.tgz
as_root rm -rf /usr/local/go
as_root tar -C /usr/local -xzf /tmp/go.tgz
rm -f /tmp/go.tgz
# The agent runs non-login shells that never source /etc/profile.d, so Go must live in
# /usr/local/bin to be on PATH at runtime; profile.d carries GOPATH.
as_root ln -sf /usr/local/go/bin/go /usr/local/bin/go
as_root ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
printf '%s\n' 'export GOPATH=$HOME/go' | as_root tee /etc/profile.d/go.sh >/dev/null
export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH
go version

case "$(dpkg --print-architecture)" in
  amd64) uvarch=x86_64 ;;
  arm64) uvarch=aarch64 ;;
  *) uvarch=x86_64 ;;
esac
curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uvarch}-unknown-linux-gnu.tar.gz" -o /tmp/uv.tgz
as_root tar -C /usr/local/bin --strip-components=1 -xzf /tmp/uv.tgz \
  "uv-${uvarch}-unknown-linux-gnu/uv" "uv-${uvarch}-unknown-linux-gnu/uvx"
rm -f /tmp/uv.tgz
uv --version

# Root installs the interpreter into a shared prefix so the tenki user runs the same one.
# /usr/local/bin precedes /usr/bin, so `python3` becomes 3.13 while the base's 3.12 stays
# reachable at /usr/bin/python3. Bare `python` has to exist too: Ubuntu ships none, and
# enough tooling shells out to it.
as_root env UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python uv python install "${PYTHON_VERSION}"
python_bin="$(as_root env UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python uv python find "${PYTHON_VERSION}")"
[ -x "$python_bin" ] || { echo "uv did not install python ${PYTHON_VERSION}" >&2; exit 1; }
as_root ln -sf "$python_bin" /usr/local/bin/python3
as_root ln -sf "$python_bin" /usr/local/bin/python
python3 --version

# uv's interpreter ships pip but marks itself externally managed, so a repository that
# installs with plain `pip install -r requirements.txt` gets refused. That marker guards
# an interpreter the OS package manager owns; this one is the image's own.
as_root rm -f "$(python3 -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')/EXTERNALLY-MANAGED"
python3 -m pip --version

# corepack caches under $HOME, so the version the tenki user gets has to be prepared as
# the tenki user; the base already enabled the shims as root. A repo that pins
# `packageManager` makes corepack switch to that version on first use.
corepack prepare pnpm@latest --activate
pnpm --version

record_versions "go version" "python3 --version" "uv --version" "pnpm --version"
