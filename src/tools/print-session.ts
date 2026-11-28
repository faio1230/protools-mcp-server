import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { PTSLClient } from '../grpc/client.js';
import { CommandId as C } from '../grpc/commands.js';
import { restoreSessionSelection, sendCompleted, type SessionSelectionSnapshot } from './mixer-state.js';

async function activeFile(client: PTSLClient): Promise<string | undefined> {
  let response;
  try {
    response = await sendCompleted(client, C.GetSessionPath);
  } catch (error) {
    if (/no[_ ]?(?:opened?[_ ]?|active[_ ]?)?session|session[_ ]?(?:is[_ ]?)?not[_ ]?open/i.test(String(error))) return undefined;
    throw error;
  }
  const file = response.response_body?.session_path?.path;
  if (file === '') return undefined;
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Pro Tools returned an invalid session path.');
  return realpath(file);
}

async function isPrintCopy(file: string | undefined, workDir: string, copyName: string) {
  if (!file) return false;
  const relative = path.relative(await realpath(workDir), file);
  return !path.isAbsolute(relative) && !relative.split(path.sep).includes('..') &&
    path.basename(file).toLowerCase() === copyName.toLowerCase() + '.ptx';
}

export async function assertPrintCopy(client: PTSLClient, workDir: string, copyName: string) {
  if (!await isPrintCopy(await activeFile(client), workDir, copyName)) {
    throw new Error('Print working copy is not active. Stopped before editing.');
  }
}

export async function restorePrintSource(
  client: PTSLClient, snapshot: SessionSelectionSnapshot, workDir: string, copyName: string
) {
  const source = snapshot.sessionPath;
  const active = await activeFile(client);
  if (active === source) return;
  if (active) {
    if (!await isPrintCopy(active, workDir, copyName)) throw new Error('An unrelated session is active: ' + active);
    try {
      await sendCompleted(client, C.CloseSession, { save_on_close: false });
    } catch (error) {
      // A lost completion can follow a successful close. Never close twice.
      if (await activeFile(client)) throw error;
    }
  }
  await sendCompleted(client, C.OpenSession, { session_path: source });
  await restoreSessionSelection(client, snapshot);
}
