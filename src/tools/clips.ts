import { PTSLClient } from '../grpc/client.js';
import { CommandId } from '../grpc/commands.js';

/**
 * Clip management MCP tools
 */

export const clipTools = [
  {
    name: 'get_clip_list',
    description: 'Get the clip library - all imported audio files available in the session. ' +
      'This is the "clip bin" or media pool, NOT clips currently on the timeline. ' +
      'Use this ONLY when you need to see what audio files are available to use. ' +
      'To see clips actually placed on the timeline, use get_timeline_clips instead.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export async function handleClipTool(
  toolName: string,
  _args: any,
  client: PTSLClient
): Promise<any> {
  switch (toolName) {
    case 'get_clip_list':
      return await getClipList(client);
    default:
      throw new Error(`Unknown clip tool: ${toolName}`);
  }
}

/**
 * Format a clip object from PTSL response into a readable summary
 */
function formatClip(clip: any, index: number): string {
  let summary = `${index + 1}. **${clip.clip_full_name || clip.clip_root_name || 'Unknown'}**\n`;

  // Type and online status
  if (clip.clip_type) {
    summary += `   Type: ${clip.clip_type}`;
    if (clip.is_online !== undefined) {
      summary += ` (${clip.is_online ? 'Online' : 'Offline'})`;
    }
    summary += '\n';
  }

  // Clip range (start/end points)
  const startPos = clip.start_point?.position;
  const endPos = clip.end_point?.position;
  if (startPos !== undefined && endPos !== undefined) {
    const duration = endPos - startPos;
    summary += `   Range: ${startPos.toLocaleString()} - ${endPos.toLocaleString()} samples (${duration.toLocaleString()} samples)\n`;
  }

  // Source file range (only show if different from clip range)
  const srcStart = clip.src_start_point?.position;
  const srcEnd = clip.src_end_point?.position;
  if (srcStart !== undefined && srcEnd !== undefined && (srcStart !== startPos || srcEnd !== endPos)) {
    summary += `   Source Range: ${srcStart.toLocaleString()} - ${srcEnd.toLocaleString()} samples\n`;
  }

  // Sync point
  if (clip.sync_point?.position !== undefined) {
    summary += `   Sync Point: ${clip.sync_point.position.toLocaleString()} samples\n`;
  }

  // Timestamps
  if (clip.original_timestamp_point?.location) {
    summary += `   Original Timestamp: ${parseInt(clip.original_timestamp_point.location).toLocaleString()} samples\n`;
  }
  if (clip.user_timestamp_point?.location &&
      clip.user_timestamp_point.location !== clip.original_timestamp_point?.location) {
    summary += `   User Timestamp: ${parseInt(clip.user_timestamp_point.location).toLocaleString()} samples\n`;
  }

  // Transpose
  if (clip.transpose_semitones || clip.transpose_cents) {
    summary += `   Transpose: ${clip.transpose_semitones || 0} semitones, ${clip.transpose_cents || 0} cents\n`;
  }

  // Group
  if (clip.group_name) {
    summary += `   Group: ${clip.group_name}\n`;
  }

  // IDs
  if (clip.clip_id) {
    summary += `   Clip ID: ${clip.clip_id}\n`;
  }
  if (clip.file_id) {
    summary += `   File ID: ${clip.file_id}\n`;
  }

  return summary;
}

/**
 * Sample PTSL response:
 * {
 *   "response_body": {
 *     "clip_list": [
 *       {
 *         "clip_id": "f824c5d4-79d4-46b2-8011-8519b50b4e58",
 *         "clip_full_name": "BCST 120_PT Editing_Music_Choice 3-02.L",
 *         "clip_root_name": "BCST 120_PT Editing_Music_Choice 3-02",
 *         "clip_type": "ClipType_Audio",
 *         "is_online": true,
 *         "start_point": { "time_type": "BTType_Samples", "position": 30690 },
 *         "end_point": { "time_type": "BTType_Samples", "position": 572808 },
 *         "sync_point": { "time_type": "BTType_Samples", "position": 30690 },
 *         "original_timestamp_point": { "time_type": "TLType_Samples", "location": "172830690" },
 *         "user_timestamp_point": { "time_type": "TLType_Samples", "location": "172830690" },
 *         "transpose_semitones": 0,
 *         "transpose_cents": 0
 *       }
 *     ]
 *   }
 * }
 */
async function getClipList(client: PTSLClient) {
  try {
    const response = await client.sendRequest(CommandId.GetClipList);

    if (response.header?.status === 'Failed') {
      const errorJson = response.response_error_json || '{}';
      const errorData = JSON.parse(errorJson);
      const errorMessages = errorData.errors?.map((e: any) => e.command_error_message).join(', ') || 'Unknown error';

      return {
        content: [
          {
            type: 'text',
            text: `Failed to get clip list: ${errorMessages}`,
          },
        ],
        isError: true,
      };
    }

    // Get clips from response (field name is clip_list, not clips)
    const clips = response.response_body?.clip_list || [];

    if (clips.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: '**Clip List**\n\nNo clips found in session.',
          },
        ],
      };
    }

    // Format each clip using the actual JSON structure
    const clipSummary = clips.map(formatClip).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `**Clip List** (${clips.length} clips)\n\n` +
                `${clipSummary}\n\n` +
                `**Note:** This shows imported audio files in the clip list. ` +
                `To see clip positions on the timeline, use \`search_timeline\`.`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting clip list: ${error}`,
        },
      ],
      isError: true,
    };
  }
}

