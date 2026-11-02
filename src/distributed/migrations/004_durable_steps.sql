-- 004_durable_steps.sql — per-step checkpoint + effect ledger (Phase 4).

ALTER TABLE dist_task_runs MODIFY status
  ENUM('queued','running','retry_wait','succeeded','dead','cancelled','needs_review') NOT NULL;

CREATE TABLE IF NOT EXISTS dist_run_steps (
  run_id CHAR(36) NOT NULL,
  step_key VARCHAR(128) NOT NULL,
  kind ENUM('compute','effect') NOT NULL,
  status ENUM('intent','committed','unknown','failed') NOT NULL,
  lease_token BIGINT NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NULL,
  output JSON NULL,
  provider_ref VARCHAR(128) NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (run_id, step_key),
  KEY idx_unknown (status, updated_at)
) ENGINE = InnoDB;
