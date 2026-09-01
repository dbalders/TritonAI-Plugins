# Synthetic Read-only

This dependency-free plugin is the executable conformance fixture for the additive TritonAI
plugin SDK v1. It exposes one deterministic read tool and never calls `beginCommit`.

Build a sealed artifact from the repository root:

```sh
node scripts/build-sdk-artifact.mjs plugins/synthetic-readonly /tmp/synthetic-readonly-artifact
```
