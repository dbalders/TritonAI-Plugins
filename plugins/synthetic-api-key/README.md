# Synthetic API Key

SDK2 conformance provider with one read and one write tool. A test-owned host keeps the fixture
API key, connection lifecycle and item state; the worker only requests the exact admitted operation.
It performs no direct networking. Older SDK1 hosts reject version 2.0.0 without fallback.

This is a test fixture. Its tests do not prove native confinement or a live production integration.
