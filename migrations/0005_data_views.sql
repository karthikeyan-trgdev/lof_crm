-- Version 2 data views: one flat, readable view per business area for Settings → Database, CSV export,
-- BI tools and ad-hoc SQL (wrangler d1 execute lof_crm --remote --command "SELECT * FROM v_instalments").
-- Views only read; they never change data. Passwords, two-step secrets and session tokens are never exposed.

DROP VIEW IF EXISTS v_students;
CREATE VIEW v_students AS
SELECT id, branch, status,
       json_extract(data,'$.first') AS first_name, json_extract(data,'$.last') AS last_name,
       json_extract(data,'$.dob') AS dob, json_extract(data,'$.email') AS student_email, json_extract(data,'$.mobile') AS student_mobile,
       json_extract(data,'$.fam') AS family_id,
       json_extract(data,'$.parents[0].name') AS parent_name, json_extract(data,'$.parents[0].mobile') AS parent_mobile,
       json_extract(data,'$.parents[0].email') AS parent_email, json_extract(data,'$.reg') AS registered_on, is_test
FROM docs WHERE type='student';

DROP VIEW IF EXISTS v_enrollments;
CREATE VIEW v_enrollments AS
SELECT id, ref1 AS student_id, ref2 AS opportunity_id, branch, status, at AS enrolled_on,
       json_extract(data,'$.prog') AS programme, json_extract(data,'$.pkg') AS package,
       json_extract(data,'$.cslr') AS counsellor, json_extract(data,'$.term') AS payment_term,
       json_extract(data,'$.cur') AS currency, json_extract(data,'$.fee') AS fee,
       json_extract(data,'$.reg') AS registration, json_extract(data,'$.disc') AS discount,
       json_extract(data,'$.tax') AS tax, json_extract(data,'$.total') AS total,
       json_extract(data,'$.paid') AS paid, round(json_extract(data,'$.total') - json_extract(data,'$.paid'), 2) AS outstanding,
       json_extract(data,'$.payStatus') AS payment_status, is_test
FROM docs WHERE type='enrollment';

-- One row per instalment of every enrolment (status is shown in the CRM; here: amount and due date)
CREATE VIEW IF NOT EXISTS v_instalments AS
SELECT d.id AS enrollment_id, d.ref1 AS student_id, d.branch, d.status AS enrollment_status,
       json_extract(d.data,'$.term') AS payment_term, json_extract(d.data,'$.cur') AS currency,
       json_extract(i.value,'$.n') AS instalment, json_extract(i.value,'$.pct') AS percent,
       json_extract(i.value,'$.due') AS due_date, json_extract(i.value,'$.amt') AS amount,
       json_extract(d.data,'$.paid') AS enrollment_paid, d.is_test
FROM docs d, json_each(json_extract(d.data,'$.sched')) i
WHERE d.type='enrollment';

CREATE VIEW IF NOT EXISTS v_refunds AS
SELECT id, ref1 AS enrollment_id, branch, status, at AS requested_at,
       json_extract(data,'$.amt') AS amount, json_extract(data,'$.suggested') AS suggested,
       json_extract(data,'$.rule') AS rule, json_extract(data,'$.days') AS days_since_enrolment,
       json_extract(data,'$.sessions') AS sessions_attended, json_extract(data,'$.exception') AS exception,
       json_extract(data,'$.approverRole') AS approver_role, json_extract(data,'$.by') AS requested_by,
       coalesce(json_extract(data,'$.approvedBy'), json_extract(data,'$.processedBy'), json_extract(data,'$.rejectedBy')) AS decided_by,
       json_extract(data,'$.reason') AS reason, is_test
FROM docs WHERE type='refund';

CREATE VIEW IF NOT EXISTS v_lms_calls AS
SELECT id, ref1 AS enrollment_id, ref2 AS student_id, branch, status, at AS last_attempt,
       coalesce(json_extract(data,'$.op'), 'enrol') AS call, json_extract(data,'$.cid') AS track,
       json_array_length(coalesce(json_extract(data,'$.credits'), '[]')) AS credits,
       json_extract(data,'$.attempts') AS attempts, json_extract(data,'$.err') AS error, is_test
FROM docs WHERE type='moodle_sync';

CREATE VIEW IF NOT EXISTS v_approvals AS
SELECT id, branch, status, at AS requested_at, json_extract(data,'$.type') AS type,
       json_extract(data,'$.summary') AS summary, json_extract(data,'$.by') AS requested_by,
       json_extract(data,'$.approverRole') AS approver_role, json_extract(data,'$.decision.by') AS decided_by,
       json_extract(data,'$.decision.at') AS decided_at, json_extract(data,'$.decision.remarks') AS remarks, is_test
FROM docs WHERE type='approval';

CREATE VIEW IF NOT EXISTS v_tasks AS
SELECT id, ref1 AS lead_id, branch, owner AS counsellor, status, at AS due,
       json_extract(data,'$.type') AS type, json_extract(data,'$.outcome') AS outcome, json_extract(data,'$.remarks') AS remarks, is_test
FROM docs WHERE type='task';

CREATE VIEW IF NOT EXISTS v_calls AS
SELECT id, ref1 AS lead_id, branch, at AS called_at, json_extract(data,'$.dir') AS direction,
       json_extract(data,'$.status') AS status, json_extract(data,'$.dur') AS minutes,
       json_extract(data,'$.outcome') AS outcome, json_extract(data,'$.by') AS counsellor, is_test
FROM docs WHERE type='call';

-- Staff with their sign-in state (never the password hash or two-step secret)
CREATE VIEW IF NOT EXISTS v_staff AS
SELECT d.id, json_extract(d.data,'$.name') AS name, json_extract(d.data,'$.role') AS role, d.branch,
       json_extract(d.data,'$.email') AS email, json_extract(d.data,'$.status') AS employment,
       json_extract(d.data,'$.access') AS access,
       CASE WHEN a.staff_id IS NULL THEN 0 ELSE 1 END AS has_login, coalesce(a.mfa_enabled, 0) AS two_step,
       a.must_change AS must_change_password, a.last_login_at, a.locked_until
FROM docs d LEFT JOIN staff_auth a ON a.staff_id = d.id
WHERE d.type='staff';

CREATE VIEW IF NOT EXISTS v_targets AS
SELECT json_extract(t.value,'$.m') AS month, json_extract(t.value,'$.c') AS counsellor,
       json_extract(t.value,'$.enr') AS enrolment_target, json_extract(t.value,'$.rev') AS revenue_target,
       json_extract(t.value,'$.conv') AS conversion_target
FROM settings s, json_each(json_extract(s.data,'$.targets')) t
WHERE s.key='cfg';

CREATE VIEW IF NOT EXISTS v_audit AS
SELECT id, at, json_extract(data,'$.by') AS user, json_extract(data,'$.act') AS action,
       json_extract(data,'$.ref') AS reference, json_extract(data,'$.det') AS detail, is_test
FROM docs WHERE type='audit';
