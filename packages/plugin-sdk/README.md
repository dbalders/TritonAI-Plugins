# TritonAI Plugin SDK

Effect-free types and validation for the additive TritonAI plugin SDK v1. The runtime has no
dependencies and is safe to use before importing a plugin module.

The SDK intentionally does not provide logging, network, update-catalog, or isolation APIs. Use
the repository artifact builder to seal one reviewed plugin entry and its declared static imports.

## Host contract levels

`sdk.requiredHostContractLevel` is a monotonic feature floor. A host loads plugins at or below its
level and refuses newer requirements.

- Level 1: generic SDK admission.
- Level 2: bounded API-key setup instructions and an HTTPS setup deep link.
- Level 3: optional manifest `serviceEnvironments` (2–4 entries of `id`, `displayName`, and
  `description`; the first is the default). The host persists the user's choice and passes its id
  as `context.serviceEnvironment` to every provider operation. Providers keep each environment's
  credentials separate and, when an operation arrives for a different environment than the last
  one, cancel sign-ins still pending in the others without touching stored credentials. Declaring
  environments requires level 3.
