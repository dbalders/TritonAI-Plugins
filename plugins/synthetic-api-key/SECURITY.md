# Security

The worker receives only configuration and an operation broker. The host owns synthetic credentials,
connection grants, item writes and commit admission. No raw-secret, network, filesystem, process,
connection lifecycle or generic proxy API is supplied. The recipe is a dependency declaration that
requires separate host approval. Package fixtures model authorization and replay/cancellation;
they do not establish an OS sandbox or replace the Harness F05/F06 acceptance gates.
