# Common worker base, shared by every repo image.
#
# Sourced by tenki-images/build.sh after a preamble that defines `as_root`, strict
# mode, and exports CODEX_VERSION; not runnable standalone. Transcribed from
# the proven jardinero-worker setup in scripts/tenki-template.ts so every
# worker has the same git/gh/Codex foundation regardless of repo toolchain.

if command -v apt-get >/dev/null 2>&1; then
  as_root apt-get update
  as_root apt-get install -y \
    build-essential ca-certificates curl git gnupg jq \
    openssh-client pkg-config ripgrep sudo unzip xz-utils
else
  echo "apt-get unavailable; relying on base image tooling" >&2
fi

# Node 24 is required to install and run the Codex CLI (an npm package).
install_node24() {
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 24 ] 2>/dev/null && return 0
  as_root mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/nodesource.gpg.key
  gpg --dearmor -o /tmp/nodesource.gpg /tmp/nodesource.gpg.key
  as_root install -m 0644 /tmp/nodesource.gpg /etc/apt/keyrings/nodesource.gpg
  printf "%s\n" \
    "Types: deb" \
    "URIs: https://deb.nodesource.com/node_24.x/" \
    "Suites: nodistro" \
    "Components: main" \
    "Signed-By: /etc/apt/keyrings/nodesource.gpg" \
    | as_root tee /etc/apt/sources.list.d/nodesource.sources >/dev/null
  as_root apt-get update
  as_root apt-get install -y nodejs
  rm -f /tmp/nodesource.gpg /tmp/nodesource.gpg.key
}

install_github_cli() {
  command -v gh >/dev/null 2>&1 && return 0
  as_root mkdir -p /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /tmp/gh-key.gpg
  as_root install -m 0644 /tmp/gh-key.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg
  printf "%s\n" "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | as_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  as_root apt-get update
  as_root apt-get install -y gh
}

install_node24
as_root corepack enable || corepack enable || true
install_github_cli

as_root npm install -g "@openai/codex@${CODEX_VERSION}"
as_root ln -sf "$(npm config get prefix)/bin/codex" /usr/local/bin/codex
codex --version

record_versions "codex --version" "node --version" "gh --version" "git --version"
