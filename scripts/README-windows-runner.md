# Windows self-hosted deployment runner

This repository rebuilds the Docker Desktop `frontend` container immediately
after a push to `WEB_APP_DEMO` that changes `frontend/` or `docker-compose.yml`.
The runner must remain online and Docker Desktop must be running.

## One-time setup

1. Open the repository on GitHub and navigate to **Settings** → **Actions** →
   **Runners** → **New self-hosted runner**.
2. Choose **Windows** and **x64**, then run the commands GitHub displays in
   PowerShell. The commands download, configure, and register the runner with
   a short-lived registration token.
3. Start Docker Desktop and wait until its engine is running.
4. In the runner directory, start the runner:

   ```powershell
   .\run.cmd
   ```

Keep that terminal running while developing. GitHub will dispatch the frontend
rebuild job to it after each applicable push.

## Verify

Push a frontend change to `WEB_APP_DEMO`, then open the repository's
**Actions** tab. The workflow named **Deploy frontend to Windows Docker
Desktop** should start and complete. The app is available at
`http://localhost:3000`.

## Stop the automation

Press `Ctrl+C` in the runner terminal. To remove it permanently, use
**Settings** → **Actions** → **Runners** in GitHub, select the runner, and
choose **Remove**.
