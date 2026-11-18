-- Guest Intelligence R7: minimum read-only access to migration ledger for readiness.
-- Applied once by the migration role; never grants schema modification rights.
GRANT SELECT ON industry.schema_migrations TO industry_app;
-- Do not grant INSERT/UPDATE/DELETE on schema_migrations to the application role.
