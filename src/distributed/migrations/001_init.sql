-- 001_init.sql — distributed run-claiming schema (MySQL 8.0+).
-- Requires InnoDB row locking with SKIP LOCKED for claim/reap batches.

CREATE TABLE IF NOT EXISTS dist_schema_migrations (
  version INT PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS dist_task_runs (
  id CHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  status ENUM('queued','running','retry_wait','succeeded','dead','cancelled') NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  available_at DATETIME(3) NOT NULL,
  lease_owner VARCHAR(128) NULL,
  lease_token BIGINT NOT NULL DEFAULT 0,
  lease_expires_at DATETIME(3) NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  result JSON NULL,
  error TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_tenant_idem (tenant_id, idempotency_key),
  KEY idx_due (status, available_at),
  KEY idx_lease (status, lease_expires_at)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS dist_task_run_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  lease_token BIGINT NOT NULL,
  worker_id VARCHAR(128) NULL,
  event VARCHAR(32) NOT NULL,
  detail JSON NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_run (run_id, id)
) ENGINE = InnoDB;
