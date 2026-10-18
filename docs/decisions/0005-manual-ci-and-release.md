# 0005 — No automatic CI: local checks, manual release

Date: 2026-10-18 · Status: accepted

## Decision

The owner does not want GitHub Actions minutes spent, so `.github/workflows/ci.yml` runs only on
`workflow_dispatch` (its jobs stay for an occasional manual run) and `main` has no required status
checks. Instead, the developer runs `pnpm format:check && pnpm check && pnpm test && pnpm build`
(plus `pnpm test:e2e` when playback or UI changes) before review, QA runs all of them including
`pnpm test:e2e` on the ticket branch as the gate, and after the PR is merged the developer publishes
the site from a clean, up-to-date `main` with `pnpm run deploy:pages` (`scripts/deploy-pages.sh`),
which force-pushes `dist/` as a single orphan commit to `gh-pages` — the same result the old
`peaceiris/actions-gh-pages` step with `force_orphan: true` produced. A green or missing CI run
therefore says nothing about a change; revisit this if the project gets free CI minutes again.

## Exception: the Oracle Cloud relay deploy (2026-10-18)

`.github/workflows/deploy-relay-oci.yml` is `workflow_dispatch` only and is started by the owner, by
hand, from the Actions tab. It deploys webtor-relay to the owner's Oracle Cloud Always Free account
with `scripts/deploy-relay-oci.sh`. It is a workflow because the credentials live in repository
secrets, which only a workflow can read (agents can't, and the platform sandbox can't reach a VM
over SSH anyway); one run is the owner's explicit choice. Agents never trigger, re-run or watch it,
and it never gets a push/pull_request/schedule trigger. The script also runs on the owner's computer
with the same variables.
