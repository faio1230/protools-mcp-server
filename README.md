# Pro Tools MCP Server

An MCP (Model Context Protocol) server that enables AI assistants like Claude to control Pro Tools via the PTSL (Pro Tools Scripting Library) gRPC API.

> ⚠️ **Experimental Project:** This is a work in progress and not all Pro Tools features are implemented yet. Use at your own risk!

## Features

The server provides AI assistants with the following capabilities:

- **Session Management** - Query session info, save sessions, get comprehensive session overview
- **Timeline Navigation** - Browse tracks and clips with pagination, search by name, navigate the timeline
- **Track Control** - List, select, mute, solo, and manage tracks
- **Clip Management** - Find and work with audio clips on the timeline
- **Editing Operations** - Cut, copy, paste, clear, undo/redo with timeline selections
- **Markers** - Create, list, and navigate session markers
- **Transport Control** - Play, stop, record, and control playback
- **Visual Analysis** - Generate waveform images and analyze audio content (onsets, peaks, silence detection)
- **Raw PTSL Access** - Send custom PTSL commands for advanced use cases
- **Diagnostics** - Test and verify PTSL connection status

## ⚠️ Legal Notice

**This project does NOT include the PTSL.proto file from Avid's SDK.**

Due to licensing restrictions, users must download the Pro Tools Scripting Library SDK from Avid and provide their own `PTSL.proto` file. The SDK is available for registered Avid developers.

To obtain the SDK:
1. Register for an Avid developer account at [avid.com](https://www.avid.com/)
2. Download the Pro Tools Scripting Library SDK
3. Extract `PTSL.proto` from the SDK

## Prerequisites

- Node.js >= 18
- Pro Tools 2024.10 or later
- Pro Tools Scripting Library SDK (for PTSL.proto)
- Pro Tools must be running

### PTSL Server

According to Avid's documentation, the PTSL server should be automatically available when Pro Tools is running - no special configuration is needed. The server runs on `localhost:31416` by default.

**Note:** Make sure Pro Tools is actually running before attempting to connect!

## Installation

```bash
npm install
```

## Testing the Connection

Before using the MCP server, test that you can connect to Pro Tools:

```bash
# Run the test CLI with path to your PTSL.proto file
npm run test-cli -- /path/to/PTSL.proto

# Example (if SDK is in ptsl_sdk directory):
npm run test-cli -- ptsl_sdk/Source/PTSL.proto
```

The test CLI will:
1. Connect to the PTSL server on localhost:31416
2. Register a connection
3. Query session information
4. List tracks

If Pro Tools is not running or PTSL is not enabled, you'll see connection errors.

## Usage

### Claude Desktop (Recommended)

To use the MCP server with Claude Desktop, add it to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "protools": {
      "command": "node",
      "args": ["/absolute/path/to/protools-mcp-server/dist/index.js"],
      "env": {
        "PTSL_PROTO_PATH": "/absolute/path/to/PTSL.proto"
      }
    }
  }
}
```

**Example (macOS):**
```json
{
  "mcpServers": {
    "protools": {
      "command": "node",
      "args": ["/Users/username/protools-mcp-server/dist/index.js"],
      "env": {
        "PTSL_PROTO_PATH": "/Users/username/protools-mcp-server/ptsl_sdk/Source/PTSL.proto"
      }
    }
  }
}
```

After adding the configuration:
1. Restart Claude Desktop
2. Make sure Pro Tools is running
3. Ask Claude to help you with Pro Tools tasks!

### Claude Cowork (Experimental/Untested)

> ⚠️ **Note:** The Cowork connector has not been extensively tested. Claude Desktop is the recommended approach.

Claude Cowork requires HTTPS. The server will use self-signed SSL certificates for local development.

1. **Start the HTTPS server:**
   ```bash
   export PTSL_PROTO_PATH=/path/to/PTSL.proto
   ./start-cowork.sh
   ```

2. **In Claude Cowork:**
   - Click "Add custom connector"
   - Name: `Pro Tools`
   - Remote MCP server URL: `https://localhost:3000/sse`
   - Click "Add"
   - Accept the security warning (self-signed certificate is safe for localhost)

**Custom port:**
```bash
PORT=3443 PTSL_PROTO_PATH=/path/to/PTSL.proto npm run start:http
# Then use: https://localhost:3443/sse
```

## Available Tools

The MCP server provides these tools:

### Session Management
- **get_session_info** - Get current session name, path, and sample rate
- **save_session** - Save the current session

### Track Management
- **get_track_list** - List all tracks with their properties
- **select_tracks** - Select tracks by name
- **set_track_mute** - Mute/unmute tracks
- **set_track_solo** - Solo/unsolo tracks

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Test PTSL connection
npm run test-cli -- /path/to/PTSL.proto

# Test MCP server
export PTSL_PROTO_PATH=/path/to/PTSL.proto
./test-mcp.sh
./test-tools.sh
```

## Project Structure

```
protools-mcp-server/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── test-cli.ts           # Test CLI for PTSL connection
│   ├── grpc/
│   │   ├── client.ts         # PTSL gRPC client wrapper
│   │   └── commands.ts       # CommandId enum
│   ├── tools/                # MCP tools (TBD)
│   └── resources/            # MCP resources (TBD)
├── package.json
├── tsconfig.json
└── README.md
```

## Architecture

```
User Request (Claude/AI)
    ↓
MCP Server (TypeScript - this project)
    ↓
gRPC Client (generated from user's PTSL.proto)
    ↓
Pro Tools PTSL Server (localhost:31416)
    ↓
Pro Tools Application
```

## Troubleshooting

### "Failed to connect to PTSL server"

- Make sure Pro Tools is running
- Verify PTSL is enabled in Pro Tools Preferences
- Check that nothing else is using port 31416

### "Request refused. Use the RegisterConnection command first"

- This usually means Pro Tools is not running
- Try restarting Pro Tools

### "SDK_VersionMismatch: The client and host interface versions are incompatible"

- Make sure you're using the correct PTSL.proto version
- The proto version should match your Pro Tools version
- Download the matching SDK from Avid if needed

### Proto file errors

- Make sure you're using the correct PTSL.proto version
- The proto file should match your Pro Tools version
- Download the latest SDK from Avid if needed

## License

MIT License - see LICENSE file

## Acknowledgments

Pro Tools and PTSL are trademarks of Avid Technology, Inc. This is an independent open-source project and is not affiliated with or endorsed by Avid.
