-- 002_outbox.sql — transactional outbox + consumer dedupe (Phase 2).

CREATE TABLE IF NOT EXISTS dist_outbox (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('pending','published') NOT NULL DEFAULT 'pending',
  publish_attempts INT NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL,
  published_at DATETIME(3) NULL,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_pending (status, available_at, id)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS dist_consumed_messages (
  consumer VARCHAR(64) NOT NULL,
  message_id VARCHAR(64) NOT NULL,
  run_id CHAR(36) NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  consumed_at DATETIME(3) NOT NULL,
  PRIMARY KEY (consumer, message_id)
) ENGINE = InnoDB;
