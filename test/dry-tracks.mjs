import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandId as C } from '../dist/grpc/commands.js';
import { handleToolCall } from '../dist/tools/index.js';

function pcm24(frames, channels) {
  const align = channels * 3, b = Buffer.alloc(44 + frames * align);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(channels,22);
  b.writeUInt32LE(48000,24); b.writeUInt32LE(48000 * align,28);
  b.writeUInt16LE(align,32); b.writeUInt16LE(24,34); b.write('data',36);
  b.writeUInt32LE(frames * align,40); return b;
}

async function host(t, switchCopy = true) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(),'dry-track-test-')));
  t.after(() => rm(root,{recursive:true,force:true}));
  const original = path.join(root,'Original.ptx');
  await writeFile(original,'original'); let session = original;
  let name, range; const edits = [];
  const tracks = ['Backing','Voice'].map((name,i) => ({ name, type:'TT_Audio', format:i ? 'TF_Mono':'TF_Stereo', track_attributes:{contains_clips:true, is_frozen:i === 0} }));
  return {
    original, edits,
    async run() {
      const client = { isPermissionGroupAllowed: () => true, async sendRequest(id, b) {
        let body = {};
        switch (id) {
          case C.GetSessionPath: body = {session_path:{path:session}}; break;
          case C.GetTrackList:
            assert.deepEqual(b.track_filter_list,[{filter:'All',is_inverted:false}]);
            body = {track_list:tracks}; break;
          case C.SetTrackFrozenState:
            assert.notEqual(session,original); assert.deepEqual(b,{track_names:['Backing'],enabled:false});
            tracks[0].track_attributes.is_frozen = false; break;
          case C.GetSessionSampleRate: body = {sample_rate:'SR_48000'}; break;
          case C.SaveSessionAs:
            if (switchCopy) { session = path.join(b.session_location,b.session_name+'.ptx'); await writeFile(session,'copy'); }
            break;
          case C.GetEditModeOptions: body = {edit_mode_options:{link_track_and_edit_selection:false}}; break;
          case C.GetMainCounterFormat: body = {current_setting:'TimeCode'}; break;
          case C.SetEditModeOptions: case C.SetMainCounterFormat: break;
          case C.SelectTracksByName: name = b.track_names[0]; body = {track_list:[{name}]}; break;
          case C.SelectAllClipsOnTrack: range = name === 'Backing' ? [5,35] : [12,42]; break;
          case C.GetTimelineSelection: body = {in_time:String(range[0]),out_time:String(range[1])}; break;
          case C.SetTimelineSelection: range = [Number(b.in_time),Number(b.out_time)]; break;
          case C.ConsolidateClip:
            assert.notEqual(session,original); edits.push([name,...range]); break;
          case C.ExportClipsAsFiles:
            assert.ok(b.file_path.endsWith(path.sep));
            await writeFile(path.join(b.file_path,'clip.wav'),pcm24(range[1]-range[0],b.format === 'EF_Mono' ? 1 : 2));
            break;
          default: assert.fail('unexpected PTSL command '+id);
        }
        return {header:{status:'Completed'},response_body:body};
      } };
      return handleToolCall('export_dry_tracks',{tracks:['Backing','Voice']},client);
    },
  };
}
test('print from a verified copy with native channel counts and the union of the clip ranges',async t => {
  const h=await host(t); const r=JSON.parse((await h.run()).content[0].text);
  assert.deepEqual(h.edits,[['Backing',5,42],['Voice',5,42]]);
  assert.deepEqual(r.files.map(x=>[x.channels,x.frames]),[[2,37],[1,37]]);
  assert.deepEqual((await readdir(r.folder)).sort(),['Backing.wav','Voice.wav']);
  assert.equal(await readFile(h.original,'utf8'),'original');
});
test('abort before editing when Save As leaves the original active',async t => {
  const h=await host(t,false);
  await assert.rejects(h.run(),/working copy is not active/);
  assert.deepEqual(h.edits,[]);
});
