CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS surveys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  survey_key VARCHAR(255) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  thank_you_message TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'Draft',
  brand_name VARCHAR(255),
  logo_url VARCHAR(255),
  primary_colour VARCHAR(20),
  footer_text VARCHAR(255),
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS survey_questions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  survey_id INT NOT NULL,
  question_text TEXT NOT NULL,
  question_type VARCHAR(50) NOT NULL,
  options_json TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  required TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id)
);

CREATE TABLE IF NOT EXISTS survey_invites (
  id INT AUTO_INCREMENT PRIMARY KEY,
  survey_id INT NOT NULL,
  recipient_name VARCHAR(255),
  recipient_email VARCHAR(255),
  source_app VARCHAR(255),
  event_type VARCHAR(255),
  metadata_json TEXT,
  invite_token VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL DEFAULT 'Pending',
  sent_at DATETIME,
  opened_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id)
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  survey_id INT NOT NULL,
  invite_id INT,
  submitted_at DATETIME NOT NULL,
  ip_address VARCHAR(100),
  user_agent TEXT,
  FOREIGN KEY (survey_id) REFERENCES surveys(id),
  FOREIGN KEY (invite_id) REFERENCES survey_invites(id)
);

CREATE TABLE IF NOT EXISTS survey_answers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  response_id INT NOT NULL,
  question_id INT NOT NULL,
  answer_text TEXT,
  answer_json TEXT,
  FOREIGN KEY (response_id) REFERENCES survey_responses(id),
  FOREIGN KEY (question_id) REFERENCES survey_questions(id)
);

CREATE TABLE IF NOT EXISTS api_clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_name VARCHAR(255) NOT NULL,
  api_key_hash VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'Active',
  allowed_surveys_json TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  api_client_id INT NOT NULL,
  source_app VARCHAR(255) NOT NULL,
  event_type VARCHAR(255) NOT NULL,
  recipient_name VARCHAR(255),
  recipient_email VARCHAR(255) NOT NULL,
  metadata_json TEXT,
  received_at DATETIME NOT NULL,
  FOREIGN KEY (api_client_id) REFERENCES api_clients(id)
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rule_name VARCHAR(255) NOT NULL,
  source_app VARCHAR(255) NOT NULL,
  event_type VARCHAR(255) NOT NULL,
  survey_id INT NOT NULL,
  delay_minutes INT NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'Active',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (survey_id) REFERENCES surveys(id)
);

CREATE TABLE IF NOT EXISTS suppressions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  reason VARCHAR(255),
  source_app VARCHAR(255),
  created_at DATETIME NOT NULL
);
