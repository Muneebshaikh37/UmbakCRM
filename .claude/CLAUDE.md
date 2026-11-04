# UmbakCRM - project context for Claude Code (read first)

This repo is the owner's fork of Twenty CRM (twentyhq/twenty). The root CLAUDE.md and AGENTS.md are the upstream coding rules and still apply. This file adds what is specific to our deployment and workflow.

## Branches
- umbak-prod is THE production branch (upstream v2.55 line plus our changes). All work branches off it and merges into it.
- - main is an untouched upstream mirror. Never commit to main.
  - - Pushing non-.md changes to umbak-prod automatically builds a Docker image. So never push straight to umbak-prod: use a feature branch and a pull request, merged only when the owner approves.
   
    - ## Production
    - - URL: https://crm.irishpayments.ie (Caddy automatic HTTPS). Owner manages DNS.
      - - Single AWS EC2 instance "CRM - crm.irishpayments.ie" (account UmbakCloud, eu-west-1, t3.medium, fixed Elastic IP, user ubuntu, reached via EC2 Instance Connect in the AWS console).
        - - Docker Compose project in /opt/twenty on the server: server, worker, postgres:16-alpine, redis:7-alpine, caddy:2-alpine. Restart policy unless-stopped.
          - - Data lives in Docker volumes prefixed twenty-crm_ (db-data, server-local-data, redis-data, caddy-data, caddy-config). Attachments are stored locally (STORAGE_TYPE local).
            - - Secrets exist ONLY in /opt/twenty/.env on the server. Never commit secrets, never print them, never put them in code, logs or PRs.
              - - Nightly DB backup: /opt/twenty/backup.sh via root cron at 02:30, kept 14 days in /home/ubuntu/backups (same server only).
               
                - ## Build pipeline
                - - Workflow: .github/workflows/umbak-build-image.yml. Triggers: push to umbak-prod (ignores *.md) or manual workflow_dispatch (input app_version, keep equal to the running production version, currently v2.55.0).
                  - - Builds packages/twenty-docker/twenty/Dockerfile target twenty for linux/amd64 (about 17 minutes) and pushes ghcr.io/muneebshaikh37/umbakcrm with tags sha-SHORTSHA and build-RUNNUMBER. The package is public, so the server pulls without login.
                    - - Upstream ships about 60 other workflows. Only the umbak one is intended to matter. If they cause failing noise, tell the owner rather than deleting them.
                      - - Check a build: GitHub repo, Actions tab, "Build UmbakCRM image".
                       
                        - ## Deploy (production)
                        - - NEVER deploy without the owner's explicit go-ahead in chat.
                          - - On the server: sudo /opt/twenty/deploy.sh ghcr.io/muneebshaikh37/umbakcrm:sha-SHORTSHA
                            - - The script runs backup.sh first, saves docker-compose.yml.prev, switches the server and worker image, validates the compose file, pulls, restarts, health-checks https://crm.irishpayments.ie/healthz for up to 5 minutes and rolls back automatically on failure.
                              - - Database migrations run on boot and are NOT reverted by a rollback. So every PR with a migration must say so, be backward compatible, and be tested against a copy of production data first.
                                - - Manual rollback: restore /opt/twenty/docker-compose.yml.prev, run docker compose up -d, and if needed restore the newest dump in /home/ubuntu/backups.
                                  - - After a deploy, verify login, a record list, and the worker (a queued job running).
                                   
                                    - ## How to build features
                                    - 1. Prefer the Twenty apps SDK (packages/twenty-sdk) and workspace metadata (custom objects, fields, views, workflows, logic functions) for new features. These need no core fork changes and survive upgrades. Use the Twenty MCP tools or the app UI for metadata when appropriate.
                                      2. 2. Only change core packages (twenty-front, twenty-server) when the SDK cannot do it. Keep core diffs small, isolated in new files or modules, and avoid reformatting or renaming upstream code, so merging upstream stays easy.
                                         3. 3. Follow the existing patterns in the directory you edit. Run lint, typecheck and relevant tests with the commands in the root CLAUDE.md before opening a PR.
                                            4. 4. Every PR describes: what and why, any migration or env var needed, and how to verify on production after deploy.
                                               5. 5. New environment variables must be added to the server /opt/twenty/.env by the owner. Tell the owner the exact name and purpose; never ask for the value in chat.
                                                  6. 6. Do not edit .github/workflows/umbak-build-image.yml, deploy.sh, or Docker files unless the task is about the pipeline.
                                                    
                                                     7. ## Upgrading Twenty
                                                     8. - Upgrade deliberately, one release at a time: merge the upstream release branch (for example v2.56) into a branch off umbak-prod, resolve conflicts, bump the app_version default in the workflow, build, then deploy using the steps above. Read the release notes for migration and env changes first.
                                                       
                                                        - ## Customisation log (append one line per shipped change: date, PR, summary, build tag)
                                                        - - 2026-11-04: baseline. Stock Twenty v2.55.0 built via our pipeline (run 1, sha-11ad3b3). No custom features yet.
                                                          - 
