# One-time local setup

Install Node.js 18 or later, then download and extract the Pro Tools Scripting Library SDK that matches your version of Pro Tools from Avid. The SDK is distributed separately by Avid. Keep the extracted SDK and the server checkout in locations where your MCP client can access them.

Install the server dependencies from this checkout, then run setup.

```sh
npm ci
npm run setup
```

Setup builds the server and looks for the proto in your saved configuration, the `PTSL_PROTO_PATH` environment variable, the checkout's `ptsl_sdk` folder, and common locations under Desktop, Documents, and Downloads. If setup finds multiple proto files, enter the number of the SDK that matches Pro Tools. If it cannot locate an SDK, enter the path to the extracted SDK folder or the proto file itself. Setup accepts both `PTSL.proto` and versioned filenames such as `PTSL.2024.10.0.proto`. If you have several SDK versions, select the version that matches Pro Tools.

Choose Codex CLI, Claude Desktop, or both. For Codex, install the Codex CLI and make it available on your PATH before setup. Claude Desktop registration is supported on macOS and Windows. You can pass both choices on the command line.

```sh
npm run setup -- --client codex --proto "/path/to/extracted SDK"
npm run setup -- --client claude --proto "C:\PTSL SDK\Source\PTSL.proto"
```

Use `--client none` to save the SDK path for a client you configure yourself. Use `--sdk-version 2024.10` to record the SDK version when it is known. The setup stores a version only when explicitly provided.

Start Pro Tools and open a session. Start a new Codex session or fully quit and reopen Claude Desktop. The client launches the server as needed using the saved SDK path in your home directory's `.protools-mcp/config.json`. Run setup again if you move the SDK or change versions. If you move the server checkout, update the client registration to point to the new checkout.

## Enable stem export

Setup uses the default server permissions unless you opt in to the stem-export profile. Use this command to enable a dedicated stem-export client during initial setup or on a later run.

```sh
npm run setup -- --client codex --export-only
```

For Claude Desktop, use `--client claude`. The export profile sets `ALLOW_WRITES=export,session,print` and `PTSL_EXPORT_ONLY=1` for that client. The macOS installer at `scripts/Install-Pro-Tools-MCP.command` also uses this profile for Codex. A rerun adds those values to a matching user-level registration while preserving its other settings.

Save your native Pro Tools presets once if you plan to use these export modes. Pass the paths for the modes you use.

```sh
npm run setup -- --client codex --export-only --unity-preset "/path/to/unity Bounce Track preset" --current-preset "/path/to/current-level Bounce Track preset" --dry-import-preset "/path/to/Track Data to Import preset"
```

Use a Bounce Track preset for each wet mode. For dry current-level export, use a Track Data to Import preset saved from the Import Session Data dialog. The MCP server reads these paths from its saved settings when the client starts it. To change preset paths without editing a client registration, pass the new paths with `--client none` and start a fresh MCP session.

When Pro Tools is ready, use the server's PTSL diagnostic tool to check the connection.
