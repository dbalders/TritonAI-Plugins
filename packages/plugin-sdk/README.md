# TritonAI Plugin SDK

The root export retains the legacy Effect-free SDK1 ABI, including its raw-secret facade.
SDK1 is not compatible with isolated, credential-free workers.

`@tritonai/plugin-sdk/broker` adds SDK2 types, strict declarative manifest/recipe and operation-frame
validation, and a worker-side `createOperationBroker` framing helper. It supplies no network,
credential getter, lifecycle mutation or approval primitive. Providers receive `{configuration,
broker}` and implement `invoke(toolName, input, {signal})`. The broker accepts a reviewed operation
ID and the exact original tool input. Host identity, connection generations and F05 admission are
authoritative; worker fields cannot select or expand them.

See [the broker contract](../../docs/decisions/0002-broker-sdk-v2.md) for framing, independent host
policy approval, credential ownership, artifact versioning and required native enforcement. SDK2
artifacts fail closed on older hosts. Validation and ambient-dependency checks are integrity tools,
not proof of isolation. Package tests use test-owned host/transport fixtures only.
