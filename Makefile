REDOCLY := npx -y @redocly/cli@2.55.0
AJV     := npx -y -p ajv-cli@5.0.0 -p ajv-formats@3.0.1 ajv
COMPOSE := docker compose -f deploy/compose/dev.yml

.PHONY: contracts-lint openapi-lint events-lint db-test dev dev-down dev-reset dev-logs dev-psql dev-nats

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

# -----------------------------------------------------------------------------
# Local Dev Environment (F3)
# -----------------------------------------------------------------------------
dev: ## Start dev stack and wait for services to be healthy
	$(COMPOSE) up -d --wait

dev-down: ## Stop dev stack
	$(COMPOSE) down

dev-reset: ## Stop dev stack and delete persistent volumes
	$(COMPOSE) down -v

dev-logs: ## Follow dev stack logs
	$(COMPOSE) logs -f

dev-psql: ## Connect to dev PostgreSQL via psql
	$(COMPOSE) exec postgres psql -U winkey_migrator -d winkey

dev-nats: ## Open NATS CLI inside container
	$(COMPOSE) run --rm nats-bootstrap nats
