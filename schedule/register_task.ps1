# Registers (or re-registers) the weekly ingest with Windows Task Scheduler.
# Weekly because DPH publishes with lag and updates the portal monthly;
# a daily job would mostly no-op. Monday 09:00, runs as the current user.
schtasks /Create /F /SC WEEKLY /D MON /ST 09:00 `
  /TN "sf-inspections weekly ingest" `
  /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\Luc\projects\sf-inspections\schedule\run_ingest.ps1"
