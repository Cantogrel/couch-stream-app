import 'dotenv/config';
import OBSWebSocket from 'obs-websocket-js';

const obs = new OBSWebSocket();

const { obsWebSocketVersion, negotiatedRpcVersion } = await obs.connect(
  process.env.OBS_WEBSOCKET_URL,
  process.env.OBS_WEBSOCKET_PASSWORD
);
console.log(`Connected to obs-websocket ${obsWebSocketVersion} (RPC ${negotiatedRpcVersion})`);

const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
console.log(`Current scene: ${currentProgramSceneName}`);
console.log('Scenes:', scenes.map((s) => s.sceneName));

const { inputs } = await obs.call('GetInputList');
console.log('Existing inputs:');
for (const input of inputs) {
  console.log(`  - ${input.inputName} (${input.inputKind})`);
}

const { inputKinds } = await obs.call('GetInputKindList');
const audioKinds = inputKinds.filter((k) => k.includes('wasapi') || k.includes('input_capture'));
console.log('Available audio input kinds:', audioKinds);

await obs.disconnect();
