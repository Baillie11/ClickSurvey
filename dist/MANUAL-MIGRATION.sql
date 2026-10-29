-- Click Survey update for the existing MariaDB production installation.
-- Back up first. Select clickeco_clicksurvey in phpMyAdmin before import.
-- Requires the existing 001-hardening schema and schema_migrations table.
-- No data is deleted. Existing questions remain unconditional.

-- Earlier versions inherited the host's MyISAM default for internal tables.
ALTER TABLE schema_migrations ENGINE=InnoDB;
ALTER TABLE sessions ENGINE=InnoDB;
ALTER TABLE worker_state ENGINE=InnoDB;

ALTER TABLE surveys
  ADD COLUMN IF NOT EXISTS email_subject VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS email_sender_name VARCHAR(255) NULL;

ALTER TABLE survey_questions
  ADD COLUMN IF NOT EXISTS condition_question_id INT NULL,
  ADD COLUMN IF NOT EXISTS condition_value VARCHAR(255) NULL;

INSERT IGNORE INTO schema_migrations (version, applied_at)
VALUES ('002-survey-email', UTC_TIMESTAMP()),
       ('003-question-logic', UTC_TIMESTAMP());

-- Verify that all three migration versions are listed.
SELECT version FROM schema_migrations
WHERE version IN ('001-hardening', '002-survey-email', '003-question-logic')
ORDER BY version;
