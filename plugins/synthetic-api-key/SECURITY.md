# Security

This conformance plugin performs no network, process, or filesystem operations. It stores only its
synthetic API key through the package-scoped secret facade and crosses the host commit boundary
before credential or item mutations.
