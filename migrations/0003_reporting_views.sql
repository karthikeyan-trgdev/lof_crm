-- Flat reporting views over the document store (for BI tools, ERPNext reconciliation, ad-hoc SQL).

CREATE VIEW IF NOT EXISTS v_leads AS
SELECT id,
       json_extract(data,'$.student')  AS student,
       json_extract(data,'$.parent')   AS parent,
       json_extract(data,'$.phone')    AS phone,
       json_extract(data,'$.email')    AS email,
       branch,
       json_extract(data,'$.prog')     AS programme,
       json_extract(data,'$.src')      AS source,
       json_extract(data,'$.camp')     AS campaign,
       json_extract(data,'$.cat')      AS category,
       json_extract(data,'$.stage')    AS stage,
       status,
       owner                           AS counsellor,
       at                              AS enquiry_at,
       json_extract(data,'$.fc')       AS first_call_at,
       json_extract(data,'$.nextFU')   AS next_follow_up,
       is_test
FROM docs WHERE type='lead';

CREATE VIEW IF NOT EXISTS v_opportunities AS
SELECT id, ref1 AS lead_id, branch, owner AS counsellor, status AS stage,
       json_extract(data,'$.student') AS student, json_extract(data,'$.prog') AS programme,
       json_extract(data,'$.pkg') AS package, json_extract(data,'$.decision') AS decision,
       json_extract(data,'$.lost') AS lost_reason, ref2 AS student_id, is_test
FROM docs WHERE type='opp';

CREATE VIEW IF NOT EXISTS v_students AS
SELECT id, branch, status,
       json_extract(data,'$.first') AS first_name, json_extract(data,'$.last') AS last_name,
       json_extract(data,'$.dob') AS dob, json_extract(data,'$.moodle') AS moodle_id,
       json_extract(data,'$.parents[0].name') AS parent_name, json_extract(data,'$.parents[0].mobile') AS parent_mobile,
       json_extract(data,'$.parents[0].email') AS parent_email, at AS registered_on, is_test
FROM docs WHERE type='student';

CREATE VIEW IF NOT EXISTS v_enrollments AS
SELECT id, ref1 AS student_id, ref2 AS opportunity_id, branch, status, at AS enrolled_on,
       json_extract(data,'$.prog') AS programme, json_extract(data,'$.pkg') AS package,
       json_extract(data,'$.cur') AS currency, json_extract(data,'$.fee') AS fee,
       json_extract(data,'$.reg') AS registration, json_extract(data,'$.disc') AS discount,
       json_extract(data,'$.tax') AS tax, json_extract(data,'$.total') AS total,
       json_extract(data,'$.paid') AS paid, json_extract(data,'$.payStatus') AS payment_status, is_test
FROM docs WHERE type='enrollment';

CREATE VIEW IF NOT EXISTS v_payments AS
SELECT id, ref1 AS enrollment_id, ref2 AS student_id, branch, at AS paid_at, status,
       json_extract(data,'$.amt') AS amount, json_extract(data,'$.cur') AS currency,
       json_extract(data,'$.method') AS method, json_extract(data,'$.ref') AS reference,
       json_extract(data,'$.rc') AS receipt_no, json_extract(data,'$.gateway') AS gateway,
       json_extract(data,'$.erp.name') AS erpnext_payment_entry, is_test
FROM docs WHERE type='payment';

CREATE VIEW IF NOT EXISTS v_moodle_syncs AS
SELECT id, ref1 AS enrollment_id, ref2 AS student_id, branch, status, at AS last_sync,
       json_extract(data,'$.mid') AS moodle_user_id, json_extract(data,'$.cid') AS moodle_course_id,
       json_extract(data,'$.attempts') AS attempts, json_extract(data,'$.err') AS error
FROM docs WHERE type='moodle_sync';
