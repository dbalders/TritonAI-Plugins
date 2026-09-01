# TritonAI Plugin SDK

Effect-free types and validation for the additive TritonAI plugin SDK v1. The runtime has no
dependencies and is safe to use before importing a plugin module.

The SDK intentionally does not provide logging, network, update-catalog, or isolation APIs. Use
the repository artifact builder to seal a self-contained plugin entry.
