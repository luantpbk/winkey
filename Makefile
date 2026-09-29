REDOCLY := npx -y @redocly/cli@2.55.0
AJV     := npx -y -p ajv-cli@5.0.0 -p ajv-formats@3.0.1 ajv

.PHONY: contracts-lint openapi-lint events-lint db-test lint typecheck test build format

contracts-lint: openapi-lint events-lint ## Lint every contract

openapi-lint:
	$(REDOCLY) lint contracts/openapi/*.v1.yaml

# Compiles every event schema and validates contracts/events/examples/<name>.json against it.
events-lint:
	@set -e; cd contracts/events; for s in *.schema.json; do \
	  [ "$$s" = envelope.schema.json ] && continue; n=$${s%.schema.json}; \
	  $(AJV) validate --spec=draft2020 -c ajv-formats --strict=true -s $$s -r envelope.schema.json -d examples/$$n.json; \
	done

db-test: ## Needs DATABASE_URL, psql and migrate
	scripts/db-test.sh

lint: ## Run linters across monorepo
	pnpm lint

typecheck: ## Run typecheck across monorepo
	pnpm typecheck

test: ## Run unit tests across monorepo
	pnpm test

build: ## Build monorepo packages
	pnpm build

format: ## Format code with Prettier
	pnpm format
