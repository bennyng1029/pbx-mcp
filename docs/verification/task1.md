# Task 1 live re-check — 2026-10-03

Same driver as the baseline (`docs/verification/cold-start.mjs`, fresh server process per row, three parallel calls, 30 s hard timeout), lab Asterisk 192.168.10.244, built from the Task 1 code.

| Row | Baseline | Now |
|---|---|---|
| lab, 3 fresh processes | status and endpoints HUNG > 30 s; channels false-empty | no hang; status correct in ~23 ms in all 3 rows; endpoints and channels return `Error: Permission denied` in ~23 ms |
| closed port 127.0.0.1:1 | status and endpoints HUNG > 30 s | all three return `AMI connect failed: ECONNREFUSED` in 14 ms |

Result: the hang and the false-empty answers are fixed (no hang, no empty list for an error). The two "Permission denied" results are the **correct** answer, not a remaining defect: the lab AMI user `mcp` lacks the `reporting` read permission (see `baseline.md`, root cause 1). Until the owner adds `reporting` (read) and `call` (write) to the lab `manager.conf`, the live channels/endpoints/hangup rows cannot show data; this is a Rule 6c environment item reported to the owner, not a code issue.
