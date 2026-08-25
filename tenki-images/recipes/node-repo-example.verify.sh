# Canary: prove the image can install and check this repository. Runs in a fresh
# sandbox spawned from the new snapshot, with the repository already cloned and
# the working directory at its root. Replace with your repository's own gate.
pnpm install --frozen-lockfile
pnpm run build
pnpm test
