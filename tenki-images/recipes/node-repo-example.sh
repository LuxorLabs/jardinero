# Node/TypeScript worker toolchain.
#
# Node, corepack, git, gh and Codex all come from the base, so a pnpm repository
# only has to activate the version it pins. Swap this for npm or yarn if that is
# what your repository uses.

# Pin this to your repository's `packageManager` field so the sandbox and CI agree.
PNPM_VERSION=11.23.0

# corepack caches under $HOME, so the version the tenki user gets has to be prepared
# as the tenki user; the base already enabled the shims as root.
corepack prepare "pnpm@${PNPM_VERSION}" --activate
pnpm --version

record_versions "pnpm --version"
