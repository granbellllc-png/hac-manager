---
'@hacm/core': minor
'server': minor
'web': minor
---

Add headless vault-provider status and unlock support. Jobs pause before
execution when a required `op`, `bw`, or `vault` provider is locked; an
administrator can submit a session or service-account token that is validated,
redacted, held in memory only, and never persisted before the job resumes.
