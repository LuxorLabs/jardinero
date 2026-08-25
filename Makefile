# A Self-Documenting Makefile: http://marmelab.com/blog/2016/02/29/auto-documented-makefile.html
#
# Tooling is pinned for reproducibility across devs and CI:
#   - Node major version: NODE_VERSION below + .nvmrc; run `nvm use`
#   - pnpm: exact version in the `packageManager` field of package.json
#   - typescript / biome / vite / tsx: exact versions in package.json devDeps,
#     installed deterministically from pnpm-lock.yaml by `pnpm ci`
# Nothing depends on globally-installed tools.

# Minimum supported Node major version; must match .nvmrc and package.json engines.
NODE_VERSION ?= 24

# Whether `make check` also verifies a changeset is present. Set false on main or
# a tag (push-main, release-docker), where no changeset exists by design.
CHECK_CHANGESET ?= true

# App version for the dashboard KPI: the exact release tag if on one, else
# v0.0.0-<short-sha>.
COMMIT_TAG := $(shell git describe --tags --exact-match 2>/dev/null)
COMMIT_HASH := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
ifneq ($(COMMIT_TAG),)
BUILD_VERSION ?= $(COMMIT_TAG)
else
BUILD_VERSION ?= v0.0.0-$(COMMIT_HASH)
endif

#-------------------------------------------------------------------------------
# Setup
#-------------------------------------------------------------------------------

.PHONY: check-node
check-node: ## Verify the local Node major version is >= NODE_VERSION
	@major=$$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); \
	if [ "$$major" -lt "$(NODE_VERSION)" ]; then \
		echo "Node >= $(NODE_VERSION) required (.nvmrc); found $$(node -v 2>/dev/null || echo none). Run 'nvm use'."; \
		exit 1; \
	fi

.PHONY: install
install: check-node ## Install dependencies exactly from pnpm-lock.yaml
	pnpm ci

#-------------------------------------------------------------------------------
# Develop
#-------------------------------------------------------------------------------

.PHONY: dev
dev: check-node ## Run the orchestrator locally with hot reload; tsx watch
	pnpm run dev

.PHONY: dev-web
dev-web: check-node ## Run the Vite dev server for the SPA; proxies /dashboard/api to :3000
	pnpm run dev:web

.PHONY: preview
preview: check-node build-web ## Serve the dashboard alone against a seeded throwaway database
	pnpm run ui:preview

.PHONY: build
build: check-node ## Build the server to dist/src and the dashboard SPA to dist/public
	pnpm run build

.PHONY: start
start: ## Run the compiled server; expects `make build` first
	pnpm start

.PHONY: changeset
changeset: ## Record a changeset describing your change for the next release
	pnpm run changeset

#-------------------------------------------------------------------------------
# Quality; exactly what CI runs
#-------------------------------------------------------------------------------

.PHONY: type-check
type-check: ## Type-check server and web without emitting
	pnpm run type-check

.PHONY: lint
lint: ## Lint with Biome
	pnpm run lint

.PHONY: format
format: ## Format source in place with Biome
	pnpm run format

.PHONY: check-format
check-format: ## Fail if source is not formatted
	pnpm run format:check

.PHONY: test
test: ## Run the test suite
	pnpm test

.PHONY: check-changeset
check-changeset: ## Fail if there is no changeset or it is not a single line; skip with CHECK_CHANGESET=false
ifeq ($(CHECK_CHANGESET),true)
	@files=$$(find .changeset -name '*.md' ! -name 'README.md'); \
	if [ -z "$$files" ]; then \
		echo "No changeset found. Run 'make changeset', or 'pnpm exec changeset add --empty' if no release is needed."; \
		exit 1; \
	fi; \
	for f in $$files; do \
		lines=$$(awk '/^---$$/{fm++; next} fm>=2 && NF{c++} END{print c+0}' "$$f"); \
		if [ "$$lines" -gt 1 ]; then \
			echo "$$f: changeset must be a single line (has $$lines). Keep it terse."; \
			exit 1; \
		fi; \
	done
else
	@echo "Changeset check skipped (CHECK_CHANGESET=false)."
endif

.PHONY: check
check: type-check check-format lint build-web test check-changeset ## Full pre-PR gate: type-check, format, lint, web build, tests, changeset
	@echo "All checks passed."

.PHONY: build-web
build-web: ## Build only the dashboard SPA; needed before tests, matches CI
	pnpm run build:web

#-------------------------------------------------------------------------------
# Docker local; mirrors the production build
#-------------------------------------------------------------------------------

.PHONY: docker-build
docker-build: ## Build the production image locally
	docker build -f Dockerfile.prod --build-arg NODE_VERSION=$(NODE_VERSION)-bookworm-slim --build-arg BUILD_VERSION=$(BUILD_VERSION) -t jardinero-orchestrator:local .

.PHONY: docker-run
docker-run: ## Run the production image locally on :3000; reads .env
	docker run --rm -p 3000:3000 -p 9090:9090 --env-file .env jardinero-orchestrator:local

#-------------------------------------------------------------------------------
# Docker Compose; local dev stack with hot reload
#-------------------------------------------------------------------------------

.PHONY: up
up: ## Build and start the local dev stack; hot reload
	docker compose up --build -d

.PHONY: down
down: ## Stop and remove the local dev stack
	docker compose down

.PHONY: logs
logs: ## Follow local dev stack logs
	docker compose logs -f

#-------------------------------------------------------------------------------
# Worker images
#-------------------------------------------------------------------------------

.PHONY: tenki-image
tenki-image: ## Build and publish a Tenki worker image; pass REPO=<repo>
	@test -n "$(REPO)" || { echo "REPO is required, e.g. make tenki-image REPO=my-repo" >&2; exit 1; }
	@$(if $(CODEX_VERSION),CODEX_VERSION=$(CODEX_VERSION),) tenki-images/build.sh "$(REPO)" $(FLAGS)

#-------------------------------------------------------------------------------
# Housekeeping
#-------------------------------------------------------------------------------

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf dist

.PHONY: help
.DEFAULT_GOAL := help
help: ## Show this help message
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'
