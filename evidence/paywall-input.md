# Input and implementation context

The maintainer asked to strengthen the AI guide and its executable proof: keep
the existing paywall, connect purchase lifecycle events to experiment data,
show amount provenance and unknowns, and demonstrate the same receiver with
different store fixtures. All public wording must stay product-neutral.

Implementation started from example commit
6fd724d372515f13c099c8efdeb7e37b42f5eceb. The coding assistant had prior
conversation context. It read the installed Commerce Protocol 0.1.0 schema and
SPEC.md section 9.3, and reused the existing HTTP backend, SQLite storage and
signed receiver. It authored the host adapter, experiment projection, screen and
acceptance tests in this iteration. This is an extension, not a second claim of
an empty-folder or independent AI reproduction.
