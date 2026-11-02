# Initial source release checks

Checked on 2026-11-02 using Node.js 24.18.1 on Windows. These results describe this prepared source revision, not every possible deployment.

| Check | Result |
|---|---|
| Core, MCP and DeepSeek Harness adapter regressions | 64 passed, no skips |
| Workbench fixture scenarios | 22 passed |
| Private read-only gateway scenarios | 19 passed |
| Dependency audit, including development dependencies | 0 known vulnerabilities reported by npm at the time of the check |
| Native Windows launcher source compilation | Passed; the generated executable is excluded from the source release |

The gateway checks include method rejection, identity and host validation, route whitelisting, retained local editing, bundled page resources and compressed responses. They use synthetic projects and do not expose or modify a real project. The Harness tests load published host packages rather than treating a mock as proof of compatibility.

The source export uses an explicit list of source directories. No existing databases, state mirrors, logs, screenshots, private configuration, project materials, browser data, credentials, runtime binaries or previous Git history were copied into the release. A pattern scanner checks the source tree for common credential formats, personal home paths, private tailnet addresses and unexpected data files. Pattern checks do not detect every possible secret or establish copyright ownership.

The release updates the MCP SDK to 1.32.2 and Zod to 4.6.7, refreshes transitive dependencies, replaces a machine-specific adapter path with a user-relative default, makes tests use temporary fixtures, and disposes the Harness test host before deleting its SQLite files on Windows. The dependency inventory is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The license is MIT, selected by the project owner. This source release does not include Node.js, Tailscale, operating-system fonts or branded image assets. Their licenses and service terms remain separate. AI-assisted generation does not by itself prove originality or provide a legal warranty; maintainers must review future contributions and asset provenance.

Linux CI is configured, but this local check does not claim a completed Linux CI run. The WSL companion remains optional and requires a real WSL installation and an explicit data root. Its actual device setup is not exercised by these portable fixture checks.

Reproduce the checks from a fresh checkout:

```sh
npm ci --ignore-scripts
npm test
npm run test:workbench
npm run check:release
npm audit
```
