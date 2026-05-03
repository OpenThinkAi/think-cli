# open-think-server

> **Paused.** The cortex storage role retired in AGT-026 as part of the [think-cli v2 pivot](https://openthink.dev) to a brain/nervous-system model where memories live in a local folder (see the local-fs adapter). The HTTP server's role is being rewritten as a **proxy for external event sources** (GitHub, Linear, Slack, etc.) rather than a memory backend. That work lands in AGT-027 (events + subscriptions surface) and AGT-030 (folds this package into `packages/cli/src/serve/` with a full README rewrite).
>
> Until then, the server runs but exposes only `/v1/health` and a dormant bearer-auth seam — there are no production routes mounted.
