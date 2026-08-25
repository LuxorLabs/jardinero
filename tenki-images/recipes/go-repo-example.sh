# Go worker toolchain.
#
# The base carries git, gh, Codex and a C toolchain; Go itself is not there, so
# install the toolchain your repository pins in its go.mod or CI.

GO_VERSION=1.25.3

arch="$(dpkg --print-architecture)"
curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" -o /tmp/go.tgz
as_root rm -rf /usr/local/go
as_root tar -C /usr/local -xzf /tmp/go.tgz
rm -f /tmp/go.tgz
as_root ln -sf /usr/local/go/bin/go /usr/local/bin/go
as_root ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
go version

record_versions "go version"
