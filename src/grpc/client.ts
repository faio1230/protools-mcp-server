import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandId,
  PermissionGroup,
  getCommandPermissionGroup,
  isReadOnlyCommand,
  isExportCommand
} from './commands.js';

type ApiVersion = { version: number; version_minor?: number; version_revision?: number };

const defaultVersion: ApiVersion = { version: 2025, version_minor: 10, version_revision: 0 };
const registrationTimeoutMs = 5_000;

const streamingCommands = new Set<CommandId>([
  CommandId.BounceTrack,
  CommandId.CloseSession,
  CommandId.CreateSession,
  CommandId.ExportClipsAsFiles,
  CommandId.ExportMix,
  CommandId.Import,
  CommandId.OpenSession,
  CommandId.SaveSession,
  CommandId.SaveSessionAs,
]);

const legacyStreamingCommands = new Set<CommandId>([
  CommandId.GetPTSLVersion, CommandId.GetSessionName, CommandId.ExportSessionInfoAsText,
  CommandId.RenameTargetTrack, CommandId.SetTrackInactiveState,
  CommandId.RegisterConnection, CommandId.GetTimelineSelection, CommandId.GetSessionSampleRate,
  CommandId.GetTrackList, CommandId.GetSessionPath, CommandId.GetEditModeOptions,
  CommandId.SetEditModeOptions, CommandId.GetMainCounterFormat, CommandId.SetMainCounterFormat,
  CommandId.SelectTracksByName, CommandId.SelectAllClipsOnTrack,
  CommandId.SetTimelineSelection, CommandId.ConsolidateClip, CommandId.SetTrackFrozenState,
]);


function parseVersion(value: string): ApiVersion {
  const [major, minor, revision = 0] = value.split('.').map(Number);
  if (major === 2024 && minor === 10) return { version: 5 };
  if (/^[1-5]$/.test(value)) return { version: major };
  if (/^20\d{2}\.\d{1,2}(?:\.\d{1,9})?$/.test(value) && major >= 2025 && minor >= 1 && minor <= 12) {
    return { version: major, version_minor: minor, version_revision: revision };
  }
  throw new Error(`Invalid PTSL SDK version "${value}". Use an API number such as 5 or a version such as 2025.10.0.`);
}

function formatVersion(version: ApiVersion): string {
  return version.version_minor === undefined
    ? String(version.version)
    : `${version.version}.${version.version_minor}.${version.version_revision ?? 0}`;
}

/**
 * PTSL gRPC client wrapper
 *
 * Handles connection to Pro Tools PTSL server and manages request/response communication.
 */
export class PTSLClient {
  private apiVersion: ApiVersion = defaultVersion;
  private apiVersionSource = 'compatibility default';
  private definition?: protoLoader.PackageDefinition;
  private initialization?: Promise<void>;
  private protoPackage = 'ptsl';
  private client?: grpc.Client & {
    SendGrpcRequest: (request: object, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<any>) => grpc.ClientUnaryCall;
    SendGrpcStreamingRequest: (request: object, metadata: grpc.Metadata, options: grpc.CallOptions) => grpc.ClientReadableStream<any>;
  };
  private sessionId = '';
  private registration?: Promise<string>;
  private allowedPermissionGroups: Set<PermissionGroup>;

  constructor(
    private readonly protoPath: string,
    private readonly serverAddress = 'localhost:31416',
    private readonly sdkVersion?: string,
    private appName = 'Pro Tools MCP Server',
    private companyName = 'MCP',
  ) {
    // Parse ALLOW_WRITES environment variable
    this.allowedPermissionGroups = this.parseAllowedPermissions();

    // Display permission level
    this.displayPermissionStatus();
  }

  /**
   * Parse ALLOW_WRITES environment variable into permission groups
   */
  private parseAllowedPermissions(): Set<PermissionGroup> {
    const allowed = new Set<PermissionGroup>();

    const allowWrites = process.env.ALLOW_WRITES || '';

    if (allowWrites === 'all') {
      // Allow all permission groups
      return new Set(Object.values(PermissionGroup));
    }

    if (allowWrites === '') {
      // Default: no permission groups enabled (read-only mode)
      // Exports to temp directories are allowed as a special case in checkCommandPermission
      return allowed;
    }

    // Parse comma-separated list of permission groups
    const groups = allowWrites.split(',').map(g => g.trim());
    for (const group of groups) {
      if (Object.values(PermissionGroup).includes(group as PermissionGroup)) {
        allowed.add(group as PermissionGroup);
      } else {
        console.error(`⚠️  Warning: Unknown permission group '${group}' in ALLOW_WRITES`);
      }
    }

    return allowed;
  }

  /**
   * Display current permission status
   */
  private displayPermissionStatus(): void {
    const groupNames = Array.from(this.allowedPermissionGroups).sort();

    if (groupNames.length === Object.values(PermissionGroup).length) {
      console.error('⚠️  ALL OPERATIONS ENABLED - All permission groups allowed');
    } else if (groupNames.length === 0) {
      console.error('🔒 READ-ONLY MODE - Only queries and playback allowed');
    } else {
      console.error(`🔓 GRANULAR PERMISSIONS - Allowed: ${groupNames.join(', ')}`);
    }
  }

  /** Load the developer's local schema without contacting Pro Tools. */
  async connect(): Promise<void> {
    if (this.client) return;
    const initialization = this.initialization ??= this.initialize();
    try {
      await initialization;
    } finally {
      if (this.initialization === initialization) this.initialization = undefined;
    }
  }

  private async initialize(): Promise<void> {
    try {
      const definition = await protoLoader.load(this.protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      this.protoPackage = definition['ptsl_2024_10_0.PTSL'] ? 'ptsl_2024_10_0' : 'ptsl';
      this.definition = definition;
      const service = definition[`${this.protoPackage}.PTSL`];
      if (!service || !('SendGrpcRequest' in service)) {
        throw new Error('Expected PTSL.proto or PTSL.2024.10.0.proto from the Avid SDK.');
      }

      this.selectVersion();
      // Archived definitions use a different protobuf package but share the live service path.
      const methods: grpc.ServiceDefinition = Object.fromEntries(
        Object.entries(service).map(([name, method]) => [name, { ...method, path: '/ptsl.PTSL/' + name }])
      );
      const PTSLService = grpc.makeGenericClientConstructor(methods, 'ptsl.PTSL');
      this.client = new PTSLService(
        this.serverAddress,
        grpc.credentials.createInsecure(),
        { 'grpc.enable_retries': 0 },
      ) as unknown as typeof this.client;
    } catch (error) {
      throw new Error(`Unable to initialize local PTSL schema at "${this.protoPath}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private selectVersion(): void {
    const hasMinor = this.messageFields('RequestHeader').some(field => field.name === 'version_minor');
    if (this.sdkVersion) {
      const override = parseVersion(this.sdkVersion);
      if (override.version_minor !== undefined && !hasMinor) {
        throw new Error('The configured PTSL SDK version requires a schema with version_minor in RequestHeader.');
      }
      this.apiVersion = override;
      this.apiVersionSource = 'configured SDK version';
      return;
    }
    if (this.protoPackage === 'ptsl_2024_10_0') {
      this.apiVersion = { version: 5 };
      this.apiVersionSource = 'archived 2024.10 schema';
      return;
    }

    const sourceDir = path.dirname(this.protoPath);
    const versionHeader = path.join(sourceDir, 'PTSL_Versions.h');
    if (fs.existsSync(versionHeader)) {
      const contents = fs.readFileSync(versionHeader, 'utf8');
      const major = contents.match(/\bPTSL_VERSION(?:_MAJOR)?\s*(?:=\s*)?(\d+)\b/)?.[1];
      const minor = contents.match(/\bPTSL_VERSION_MINOR\s*(?:=\s*)?(\d+)\b/)?.[1];
      const revision = contents.match(/\bPTSL_VERSION_REVISION\s*(?:=\s*)?(\d+)\b/)?.[1];
      if (major && (Number(major) < 2000 || (hasMinor && minor))) {
        this.apiVersion = parseVersion(Number(major) < 2000 ? major : `${major}.${minor}.${revision ?? 0}`);
        this.apiVersionSource = 'PTSL_Versions.h';
        return;
      }
    }

    if (hasMinor) {
      const schema = fs.readFileSync(this.protoPath, 'utf8');
      const releases = [...schema.matchAll(/@defgroup ptsl_version_(20\d{2})_(\d{2})\b/g)]
        .map(match => [Number(match[1]), Number(match[2])])
        .filter(([year, month]) => year >= 2025 && month >= 1 && month <= 12)
        .sort(([yearA, monthA], [yearB, monthB]) => yearB - yearA || monthB - monthA);
      const inferred = releases[0];
      this.apiVersion = inferred ? parseVersion(inferred.join('.')) : defaultVersion;
      this.apiVersionSource = inferred ? 'local proto release metadata (revision assumed 0)' : 'compatibility default';
    } else {
      this.apiVersion = { version: 5 };
      this.apiVersionSource = 'legacy compatibility default';
    }
  }

  private messageFields(messageName: string): { name: string }[] {
    const message = this.definition?.[`${this.protoPackage}.${messageName}`];
    return message && 'type' in message
      ? (message.type as { field?: { name: string }[] }).field ?? []
      : [];
  }

  async hasMessageField(messageName: string, fieldName: string): Promise<boolean> {
    await this.connect();
    return this.messageFields(messageName).some(field => field.name === fieldName);
  }

  async getCommandId(commandName: string): Promise<number | undefined> {
    await this.connect();
    const commandEnum = this.definition?.[`${this.protoPackage}.CommandId`];
    if (commandEnum && 'type' in commandEnum) {
      const values = (commandEnum.type as { value?: { name: string; number: number }[] }).value;
      return values?.find(({ name }) => name === commandName || name === `CId_${commandName}`)?.number;
    }
  }

  async hasCommand(commandName: string): Promise<boolean> {
    return await this.getCommandId(commandName) !== undefined;
  }

  getConnectionInfo() {
    return {
      endpoint: this.serverAddress,
      proto_path: this.protoPath,
      request_version: formatVersion(this.apiVersion),
      request_version_source: this.apiVersionSource,
      legacy_2024_10: this.apiVersion.version === 5,
    };
  }

  /** Register once per host connection, including when commands arrive concurrently. */
  async registerConnection(appName = this.appName, companyName = this.companyName): Promise<string> {
    this.appName = appName;
    this.companyName = companyName;
    if (this.sessionId && this.client?.getChannel().getConnectivityState(false) !== grpc.connectivityState.TRANSIENT_FAILURE) {
      return this.sessionId;
    }
    this.sessionId = '';
    const registration = this.registration ??= this.register(appName, companyName);
    try {
      return await registration;
    } finally {
      if (this.registration === registration) this.registration = undefined;
    }
  }

  private async register(appName: string, companyName: string): Promise<string> {
    try {
      const response = await this.sendRequest(CommandId.RegisterConnection, {
        company_name: companyName,
        application_name: appName,
      }, true, registrationTimeoutMs);
      const sessionId = response.response_body?.session_id ?? response.response_body?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new Error('RegisterConnection returned no session ID.');
      }
      this.sessionId = sessionId;
      return sessionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not register with Pro Tools at ${this.serverAddress} (PTSL request version ${formatVersion(this.apiVersion)}). ` +
        `Check that Pro Tools is running and the local Avid SDK matches the host. ${message}`,
        { cause: error },
      );
    }
  }

  /** Send a command once. A failed connection is registered again for a later command. */
  async sendRequest(commandId: number, requestBody: any = {}, skipSessionId = false, timeoutMs?: number): Promise<any> {
    this.checkCommandPermission(commandId, requestBody);
    await this.connect();

    if (streamingCommands.has(commandId) || (this.apiVersion.version <= 5 && legacyStreamingCommands.has(commandId))) {
      let completed;
      for await (const update of this.sendStreamingRequest(commandId, requestBody, skipSessionId, timeoutMs)) {
        if (update.header?.status === 'Completed') completed = update;
        else if (!['Queued', 'Pending', 'InProgress', 'WaitingForUserInput'].includes(update.header?.status)) {
          throw new Error(`PTSL command ${commandId} returned ${update.header?.status ?? 'no task status'}`);
        }
      }
      if (!completed) throw new Error('PTSL stream ended without a completion response for command ' + commandId);
      return completed;
    }

    const sessionId = skipSessionId || commandId === CommandId.RegisterConnection ? '' : await this.registerConnection();
    const request = this.buildRequest(commandId, requestBody, sessionId);
    const options = timeoutMs === undefined ? {} : { deadline: Date.now() + timeoutMs };
    const metadata = new grpc.Metadata({ waitForReady: commandId === CommandId.RegisterConnection });
    try {
      const response = await new Promise<any>((resolve, reject) => {
        this.client!.SendGrpcRequest(request, metadata, options, (error, response) => {
          if (error) reject(error);
          else resolve(response);
        });
      });
      return this.parseResponse(response, commandId);
    } catch (error) {
      throw this.handleRequestError(error, sessionId);
    }
  }

  async *sendStreamingRequest(
    commandId: number, requestBody: any = {}, skipSessionId = false, timeoutMs?: number,
  ): AsyncIterableIterator<any> {
    this.checkCommandPermission(commandId, requestBody);
    await this.connect();
    const sessionId = skipSessionId || commandId === CommandId.RegisterConnection ? '' : await this.registerConnection();
    const request = this.buildRequest(commandId, requestBody, sessionId);
    const options = timeoutMs === undefined ? {} : { deadline: Date.now() + timeoutMs };
    const metadata = new grpc.Metadata({ waitForReady: commandId === CommandId.RegisterConnection });
    try {
      const stream = this.client!.SendGrpcStreamingRequest(request, metadata, options);
      for await (const response of stream) {
        yield this.parseResponse(response, commandId);
      }
    } catch (error) {
      throw this.handleRequestError(error, sessionId);
    }
  }

  private buildRequest(commandId: number, requestBody: object, sessionId: string) {
    return {
      header: {
        command: commandId,
        ...this.apiVersion,
        ...(sessionId ? { session_id: sessionId } : {}),
      },
      request_body_json: JSON.stringify(requestBody),
    };
  }

  private parseResponse(response: any, commandId: number): any {
    if (typeof response.header?.status === 'string') {
      response.header.status = response.header.status.replace(/^TStatus_/, '');
    }
    const status = response.header?.status;
    const errorType = response.command_error_type;
    if (['Failed', 'FailedWithBadErrorResponse', 'CompletedWithBadResponse'].includes(status)
      || (errorType && errorType !== 'CmdErr_NoError')) {
      const details = response.response_error_json || errorType || 'No error details returned by host.';
      throw new Error(`PTSL command ${CommandId[commandId] ?? commandId} returned ${status ?? 'an error'}: ${details}`);
    }
    if (response.response_body_json) {
      try {
        response.response_body = JSON.parse(response.response_body_json);
      } catch {
        // Keep the original JSON string for callers and diagnostics.
      }
    }
    return response;
  }

  private handleRequestError(error: unknown, sessionId: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as Partial<grpc.ServiceError> | null)?.code;
    const lostRegistration = code === grpc.status.UNAVAILABLE || code === grpc.status.UNAUTHENTICATED
      || /\buse the RegisterConnection command first\b|\b(?:invalid|expired|unknown) (?:PTSL )?session[ _]?(?:ID|identifier)\b/i.test(message);
    if (sessionId && lostRegistration) {
      if (sessionId === this.sessionId) this.sessionId = '';
      return new Error(
        `${message}. PTSL registration was lost. The next request will attempt to reconnect to ${this.serverAddress}.`,
        { cause: error },
      );
    }
    return error instanceof Error ? error : new Error(message);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isConnected(): boolean {
    return Boolean(this.sessionId && this.client?.getChannel().getConnectivityState(false) === grpc.connectivityState.READY);
  }

  /**
   * Check if a permission group is allowed
   */
  isPermissionGroupAllowed(group: PermissionGroup): boolean {
    return this.allowedPermissionGroups.has(group);
  }

  /**
   * Get list of allowed permission groups
   */
  getAllowedPermissionGroups(): string[] {
    return Array.from(this.allowedPermissionGroups).sort();
  }


  /**
   * Check if a command is allowed based on permission groups
   */
  private checkCommandPermission(commandId: number, requestBody: any = {}): void {
    // Read-only commands are always allowed
    if (isReadOnlyCommand(commandId)) {
      return;
    }

    // Get the permission group for this command
    const group = getCommandPermissionGroup(commandId);

    if (!group) {
      // Unknown command - be conservative and block it
      throw new Error(
        `Unknown command ${commandId} - cannot determine permission requirements. ` +
        'This command is not in any known permission group.'
      );
    }

    // Special handling for export commands
    if (isExportCommand(commandId)) {
      const exportPath = this.getExportPath(commandId, requestBody);
      const isSafePath = this.isPathInTempDirectory(exportPath);

      if (isSafePath) {
        // Exports to temp directories are always allowed (for analysis)
        return;
      }

      // Non-temp exports require the export permission group
      if (!this.allowedPermissionGroups.has(PermissionGroup.EXPORT)) {
        throw new Error(
          `Export to arbitrary path blocked: Exports are only allowed to temporary directories (${os.tmpdir()}) by default. ` +
          `Attempted path: ${exportPath}. ` +
          'To enable exports to any location, set ALLOW_WRITES=export or ALLOW_WRITES=all'
        );
      }

      // Export permission granted, allow export to any path
      return;
    }

    // Check if this permission group is allowed
    if (!this.allowedPermissionGroups.has(group)) {
      const groupName = group;
      const allowedGroups = this.getAllowedPermissionGroups();

      throw new Error(
        `Permission denied: This command requires the '${groupName}' permission group. ` +
        `Currently allowed groups: ${allowedGroups.length > 0 ? allowedGroups.join(', ') : 'none (read-only mode)'}. ` +
        `To enable this operation, set ALLOW_WRITES=${groupName} or ALLOW_WRITES=all`
      );
    }
  }

  private getExportPath(commandId: number, requestBody: any): unknown {
    switch (commandId) {
      case CommandId.ExportClipsAsFiles:
        return requestBody.file_path;
      case CommandId.ExportSessionInfoAsText:
        return requestBody.output_path;
      case CommandId.ExportMix:
      case CommandId.BounceTrack: {
        const location = requestBody.location_info;
        const directoryDestinations = ['Directory', 'EM_FD_Directory', 'EMFDestination_Directory'];
        if (!directoryDestinations.includes(location?.file_destination)) return undefined;
        const importAfterBounce = location.import_after_bounce;
        if (importAfterBounce != null && ![false, 'False', 'TB_False'].includes(importAfterBounce)) return undefined;
        // Directory and file name are independent PTSL fields.
        for (const name of [requestBody.file_name, requestBody.file_name_prefix]) {
          if (name !== undefined && (typeof name !== 'string' || /[/\\]/.test(name) || name === '..')) return undefined;
        }
        return location.directory;
      }
      default:
        return undefined;
    }
  }

  /** Permit only absolute paths that remain inside the local temporary directory when resolved. */
  private isPathInTempDirectory(filePath: unknown): boolean {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.split(/[/\\]/).includes('..')) {
      return false;
    }

    try {
      const temporary = fs.realpathSync(os.tmpdir());
      // The file itself may be new. Resolve the nearest existing ancestor to catch symlink escapes.
      let ancestor = path.resolve(filePath);
      while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (ancestor === parent) return false;
        try {
          // A dangling symlink also cannot safely be resolved as a new path.
          if (fs.lstatSync(ancestor).isSymbolicLink()) return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        }
        ancestor = parent;
      }
      const relative = path.relative(temporary, fs.realpathSync(ancestor));
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    } catch {
      return false;
    }
  }
}
