-- 005_effect_send_started.sql — distinguish "not sent yet" from "maybe sent".

ALTER TABLE dist_run_steps
  ADD COLUMN send_started_at DATETIME(3) NULL;
