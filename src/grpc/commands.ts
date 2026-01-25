/**
 * PTSL Command IDs
 *
 * These are the command ID numbers from the PTSL.proto file.
 * Command IDs are just numbers - public knowledge, not copyrighted.
 */
export enum CommandId {
  // Connection
  RegisterConnection = 70,
  GetPTSLVersion = 55,

  // Session Management
  CreateSession = 0,
  OpenSession = 1,
  CloseSession = 17,
  SaveSession = 18,
  SaveSessionAs = 19,

  // Session Properties
  GetSessionName = 42,
  GetSessionPath = 43,
  GetSessionSampleRate = 35,
  GetSessionBitDepth = 36,
  GetSessionTimeCodeRate = 38,
  GetSessionStartTime = 44,
  GetSessionLength = 45,
  GetMainCounterFormat = 102,

  // Track Operations
  GetTrackList = 3,
  CreateNewTracks = 72,
  SelectTracksByName = 73,

  // Track Properties
  SetTrackMuteState = 85,
  SetTrackSoloState = 86,
  SetTrackRecordEnableState = 88,

  // Transport
  SetPlaybackMode = 32,
  SetRecordMode = 33,
  GetPlaybackMode = 56,
  GetRecordMode = 57,
  GetTransportState = 59,
  TogglePlayState = 64,
  ToggleRecordEnable = 65,
  PlayHalfSpeed = 66,
  RecordHalfSpeed = 67,

  // Editing
  Cut = 20,
  Copy = 21,
  Paste = 22,
  Clear = 23,

  // Edit Tools
  GetEditMode = 74,
  GetEditTool = 76,
  SetEditTool = 77,

  // Timeline
  SetTimelineSelection = 81,
  GetTimelineSelection = 82,

  // Undo/Redo
  Undo = 104,
  Redo = 105,

  // Memory Locations / Markers
  ClearMemoryLocation = 61,
  EditMemoryLocation = 68,
  GetMemoryLocations = 69,
  CreateMemoryLocation = 71,
  SelectMemoryLocation = 84,
  ClearAllMemoryLocations = 117,

  // Clips
  GetClipList = 125,
  GetTrackPlaylists = 154,
  GetPlaylistElements = 158,

  // Export
  ExportClipsAsFiles = 10,
  ExportMix = 28,
  ExportSessionInfoAsText = 30,

  // File Operations
  GetFileLocation = 16,
}
