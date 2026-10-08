# migrations

Deliberately empty: this plugin owns no tables. The manifest's
`database` declaration exists only so the shadow tick can SELECT the
whitelisted core table `heartbeat_runs` (see `coreReadTables`); the host
schema validator requires `migrationsDir` plus the
`database.namespace.migrate` capability for ANY manifest declaring
`database`, so both are declared and neither is ever exercised. This
plugin never writes a row.
