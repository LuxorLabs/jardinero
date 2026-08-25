# Python worker toolchain.
#
# The base carries git, gh, Codex and a C toolchain. uv installs and manages both
# the interpreter and the dependencies, so it is the only thing to add; swap it for
# pyenv, poetry or plain pip if that is what your repository uses.

# Pin these to your repository's own sources, so the sandbox cannot drift from CI.
UV_VERSION=0.12.5
PYTHON_VERSION=3.13

case "$(dpkg --print-architecture)" in
  amd64) uvarch=x86_64 ;;
  arm64) uvarch=aarch64 ;;
  *) uvarch=x86_64 ;;
esac
curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uvarch}-unknown-linux-gnu.tar.gz" -o /tmp/uv.tgz
as_root tar -C /usr/local/bin --strip-components=1 -xzf /tmp/uv.tgz \
  "uv-${uvarch}-unknown-linux-gnu/uv" "uv-${uvarch}-unknown-linux-gnu/uvx"
rm -f /tmp/uv.tgz

uv python install "$PYTHON_VERSION"
uv --version

record_versions "uv --version"
