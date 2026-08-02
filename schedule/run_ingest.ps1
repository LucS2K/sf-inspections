# Weekly refresh chain, invoked by Windows Task Scheduler:
# ingest -> dbt build -> export site data -> deploy.
# Each step aborts the chain on failure; detail lands in logs/ingest.log,
# meta.ingest_runs, and dbt's own logs.
Set-Location "C:\Users\Luc\projects\sf-inspections"

& ".\.venv\Scripts\python.exe" -u "ingest\fetch.py" --era new
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location "dbt"
& "..\.venv\Scripts\dbt.exe" build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Set-Location ".."

& ".\.venv\Scripts\python.exe" -u "site\build_data.py"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Deploy only once Vercel auth exists (run 'npx vercel login' once, then
# 'npx vercel link' inside site\ to create .vercel). Skipped silently until then.
if (Test-Path "site\.vercel") {
    Set-Location "site"
    npx vercel deploy --prod --yes
    Set-Location ".."
}
exit $LASTEXITCODE
