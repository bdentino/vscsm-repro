# VSCode JS Debugger Source Map Error Repro

I am having issues with the VSCode debugger not being able to bind breakpoints when remote debugging a Node.js typescript project that uses source maps. This repo is a minimal reproduction of the issue.

To reproduce:

1. Clone this repo
2. `docker compose up api`
3. In VSCode, attach debugger and set a breakpoint at line 22. (should already be in launch configs, just select 'Docker: attach to API')
4. Observe that breakpoint cannot be bound
