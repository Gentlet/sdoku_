DROP DATABASE IF EXISTS judge;
CREATE DATABASE judge
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
USE judge;

CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

  username VARCHAR(50) NOT NULL,
  phone VARCHAR(20) NOT NULL,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- 핵심: username + phone 조합이 유니크
  UNIQUE KEY uniq_username_phone (username, phone)
);

CREATE TABLE problems (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

  title VARCHAR(100) NOT NULL,
  description TEXT,

  time_limit_ms INT NOT NULL DEFAULT 2000,
  memory_limit_kb INT NOT NULL DEFAULT 262144,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE test_cases (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

  problem_id INT UNSIGNED NOT NULL,

  input_text TEXT NOT NULL,
  expected_output TEXT NOT NULL,

  is_sample TINYINT(1) NOT NULL DEFAULT 0,

  FOREIGN KEY (problem_id)
    REFERENCES problems(id)
    ON DELETE CASCADE
);

CREATE TABLE submissions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

  user_id INT UNSIGNED NOT NULL,
  problem_id INT UNSIGNED NOT NULL,

  language VARCHAR(20) NOT NULL DEFAULT 'cpp',

  status ENUM('PENDING','AC','WA','TLE','RE','CE') NOT NULL,

  exec_time_ms INT NULL,
  memory_kb INT NULL,

  code MEDIUMTEXT NOT NULL,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,

  FOREIGN KEY (problem_id)
    REFERENCES problems(id)
    ON DELETE CASCADE,

  INDEX idx_user_problem (user_id, problem_id)
);

CREATE TABLE submission_results (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

  submission_id INT UNSIGNED NOT NULL,
  test_case_id INT UNSIGNED NOT NULL,

  status ENUM('AC','WA','TLE','RE','CE') NOT NULL,

  exec_time_ms INT NULL,
  memory_kb INT NULL,

  stdout MEDIUMTEXT,
  stderr MEDIUMTEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (submission_id)
    REFERENCES submissions(id)
    ON DELETE CASCADE,

  FOREIGN KEY (test_case_id)
    REFERENCES test_cases(id)
    ON DELETE CASCADE,

  INDEX idx_submission (submission_id)
);
