-- 003_tenant_due.sql — index for tenant-aware claiming (Phase 3 fix).
-- `claimFair` groups due runs by tenant; without this index the grouped scan
-- falls back to idx_due and then sorts every due row.

ALTER TABLE dist_task_runs
  ADD KEY idx_tenant_due (status, tenant_id, available_at);
