import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { CommandId } from './commands.js';

/**
 * PTSL gRPC client wrapper
 *
 * Handles connection to Pro Tools PTSL server and manages request/response communication.
 */
export class PTSLClient {
  private protoPath: string;
  private serverAddress: string;
  private client: any;
  private sessionId: string = '';
  private connected: boolean = false;

  constructor(protoPath: string, serverAddress: string = 'localhost:31416') {
    this.protoPath = protoPath;
    this.serverAddress = serverAddress;
  }

  /**
   * Load the proto file and create the gRPC client
   */
  async connect(): Promise<void> {
    try {
      // Load proto file dynamically
      const packageDefinition = await protoLoader.load(this.protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
      const ptslService = protoDescriptor.ptsl.PTSL;

      // Create client
      this.client = new ptslService(
        this.serverAddress,
        grpc.credentials.createInsecure()
      );

      this.connected = true;
      console.error(`✓ Connected to PTSL server at ${this.serverAddress}`);
    } catch (error) {
      throw new Error(`Failed to connect to PTSL server: ${error}`);
    }
  }

  /**
   * Register connection with Pro Tools
   * This must be called before any other commands
   */
  async registerConnection(appName: string, companyName: string = 'MCP'): Promise<string> {
    const requestBody = {
      company_name: companyName,
      application_name: appName,
    };

    // RegisterConnection must be sent without a session_id
    const response = await this.sendRequest(CommandId.RegisterConnection, requestBody, true);

    if (response.response_body && response.response_body.session_id) {
      this.sessionId = response.response_body.session_id;
      console.error(`✓ Registered connection with session ID: ${this.sessionId}`);
      return this.sessionId;
    }

    throw new Error('Failed to register connection - no session ID returned');
  }

  /**
   * Send a request to Pro Tools
   */
  async sendRequest(commandId: number, requestBody: any = {}, skipSessionId: boolean = false): Promise<any> {
    if (!this.connected) {
      throw new Error('Not connected to PTSL server. Call connect() first.');
    }

    return new Promise((resolve, reject) => {
      const header: any = {
        command: commandId,  // Note: field is called 'command', not 'command_id'
        version: 2025,       // PTSL API version (year)
        version_minor: 10,   // PTSL API version (month)
        version_revision: 0, // PTSL API revision
      };

      // Only include session_id if we have one and not explicitly skipping it
      if (this.sessionId && !skipSessionId) {
        header.session_id = this.sessionId;
      }

      const request = {
        header,
        request_body_json: JSON.stringify(requestBody),
      };

      this.client.SendGrpcRequest(request, (error: any, response: any) => {
        if (error) {
          reject(new Error(`gRPC error: ${error.message}`));
          return;
        }

        // Check for command errors
        if (response.command_error_type && response.command_error_type !== 'CmdErr_NoError') {
          const errorMessage = response.response_error_json
            ? JSON.parse(response.response_error_json)
            : { error_type: response.command_error_type };
          reject(new Error(`Command error: ${JSON.stringify(errorMessage, null, 2)}`));
          return;
        }

        // Parse response body
        let parsedResponse = response;
        if (response.response_body_json) {
          try {
            parsedResponse.response_body = JSON.parse(response.response_body_json);
          } catch (e) {
            // If parsing fails, keep the raw JSON string
          }
        }

        resolve(parsedResponse);
      });
    });
  }

  /**
   * Send a streaming request to Pro Tools
   */
  async *sendStreamingRequest(commandId: number, requestBody: any = {}): AsyncIterableIterator<any> {
    if (!this.connected) {
      throw new Error('Not connected to PTSL server. Call connect() first.');
    }

    const request = {
      header: {
        session_id: this.sessionId,
        command_id: commandId,
      },
      request_body_json: JSON.stringify(requestBody),
    };

    const stream = this.client.SendGrpcStreamingRequest(request);

    for await (const response of stream) {
      // Parse response body
      if (response.response_body_json) {
        try {
          response.response_body = JSON.parse(response.response_body_json);
        } catch (e) {
          // Keep raw JSON string if parsing fails
        }
      }

      yield response;
    }
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Check if connected to Pro Tools
   */
  isConnected(): boolean {
    return this.connected;
  }
}
