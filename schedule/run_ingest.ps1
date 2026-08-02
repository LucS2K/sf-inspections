# Weekly incremental ingest, invoked by Windows Task Scheduler.
# All run detail (rows fetched, rows new, failures) goes to
# logs/ingest.log and the meta.ingest_runs table.
Set-Location "C:\Users\Luc\projects\sf-inspections"
& ".\.venv\Scripts\python.exe" -u "ingest\fetch.py" --era new
exit $LASTEXITCODE
