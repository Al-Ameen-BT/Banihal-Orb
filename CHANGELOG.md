# Changelog

## [2.0.0-dev.0] — Unreleased

This is a development version, not a production release.

Full scope and implementation limits: [pre-push feature/update inventory](docs/pre-push/2026-11-06-feature-inventory.md).

### Added

- Coordinated B2B product version, metadata checker, release-tag validation, API version endpoint and sidebar version display.
- Outbound Squid management security, certificate enrollment, replay protection, client/proxy ticket routing, and automation pause controls.
- Host integration package and production rollout documentation.

### Changed

- Restricted Squid human access to connection management and approval-ticket requests; removed configuration inspection/editing, monitoring and host-maintenance routes and navigation.
- Replaced the missing legacy Squid CI fixture with current host-package tests and enabled development-branch checks.
- Documented the WebUI worker-command integration separately from bundle polling.


- Product renamed to **BanihalOrb** across application branding, assistant/ticketing copy, email branding, package metadata and the version endpoint. Repository, infrastructure identifiers and the legal company name remain unchanged.

### Breaking changes

- Production machine access requires enrolled client certificates and signed protocol v2 messages.
- Legacy `/api/orb` and `/api/squid-web` routes return 410; integrations use scoped Squid change requests.
- Existing proxy identities cannot be transferred between clients; provision a fresh identity.

### Historical baseline

The existing [Al-Ameen-BT/B2B-Site](https://github.com/Al-Ameen-BT/B2B-Site) repository preserves earlier commits. Both package manifests previously declared `1.0.0`. No local release tags existed when versioning was introduced; these package values do not certify an official `v1.0.0` release or identify a deployed production commit.

The current development work must be committed and tested before any release tag is created. Historical release commits and remote tags must be verified before tagging an older version.
