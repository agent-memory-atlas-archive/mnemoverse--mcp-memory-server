<!-- AUTO-GENERATED from src/configs/source.json. Run `npm run generate:configs`. Do not edit by hand. -->

**VS Code** — the [VS Code extension](https://github.com/mnemoverse/mnemoverse-vscode) signs in through the browser and needs no key; that's the default path. To wire the MCP server directly instead, add this to `.vscode/mcp.json` (note: VS Code uses `servers`, not `mcpServers`). Never put a literal `mk_live_` key in that file — it's committed with the repo. The `inputs` entry below prompts for the key instead: VS Code masks what you type and stores it in its own secret storage, not in the file:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "mnemoverse-api-key",
      "description": "Mnemoverse API key (starts with mk_live_). Leave blank to skip — get one free at https://console.mnemoverse.com",
      "password": true
    }
  ],
  "servers": {
    "mnemoverse": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@mnemoverse/mcp-memory-server@latest"
      ],
      "env": {
        "MNEMOVERSE_API_KEY": "${input:mnemoverse-api-key}",
        "MNEMOVERSE_API_URL": "https://core.mnemoverse.com/api/v1"
      }
    }
  }
}
```
